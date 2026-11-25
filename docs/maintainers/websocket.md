# Browser WebSocket protocol

Browser clients connect to `GET /ws` for live activity and snapshot invalidations. HTTP snapshots remain authoritative for durable state. This protocol is separate from [worker IPC](server-worker-lifecycle.md#worker-ipc).

## Connection and envelope

Use the `leitwerk/ws/v1` subprotocol. With authentication enabled, upgrades require a valid session cookie and an `Origin` matching `server.base_url`. API token `Authorization` headers and worker credentials are rejected.

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

`instanceId` is omitted for global events. Live turn activity carries its persisted `eventSequence`, which orders events even when timestamps match.

## Durability and reconnect ordering

| Classification | Examples | Client behavior |
| --- | --- | --- |
| `durable` | Process changes, worker state, input acknowledgements, settings/wiki invalidations. | Invalidate and refetch the relevant HTTP read model. |
| `ephemeral` | Compact summaries, stream deltas, tool activity, heartbeats. | Apply live; missed frames are not replayed on this socket. |

On reconnect:

1. Reconnect to `/ws`.
2. Fetch relevant HTTP snapshots concurrently (`ui-snapshot`, lists).
3. Buffer incoming updates during fetches; keep only the latest compact summary per turn and retain detail frames only for an open execution Trace.
4. Apply buffered frames with `eventSequence > throughEventSequence` once in order (unsequenced metadata invalidations use `rebuiltAt`).
5. Refresh expanded history only while the inspector is open; compact snapshots never shorten expanded history.

## Server frames

### Connection control

- `hello` (`ephemeral`): confirms connection and protocol version.
- `pong` (`ephemeral`): responds to client `ping`.

### Durable invalidations

- `process.created`, `process.updated`, `process.deleted`
- `process.event`: carries `eventType` (for example, `tool_approval_updated` for ticket approval changes).
- `process.input.queued`, `process.input.acknowledged`
- `project.updated`, `worker.state`, `future.updated`, `session_transfer.updated`
- `wiki.updated`: carries `topicId`; clients refetch the topic or wiki index.
- `launch.updated`: carries `launchRunId` and nullable `instanceId`; clients refetch the launch run.
- `settings.updated`: installation-wide invalidation carrying `subjectId`; clients refresh future-step previews without mutating captured start history.

### Live and turn activity

| Frame | Contract |
| --- | --- |
| `primary_path.summary_updated` | Ephemeral bounded summary for one `turnRecordId` with `throughEventSequence`. |
| `process.toast` | Ephemeral operator toast notification. |
| `pi.stream.delta`, `pi.tool.started`, `pi.tool.completed`, `pi.usage`, `pi.error`, `pi.retry.*`, `pi.compaction.*` | Ephemeral recorded activity for an open execution Trace, correlated by `turnRecordId` and `eventSequence`. |
| `primary_path.assistant_partial`, `primary_path.tool_call_started`, `primary_path.tool_call_completed`, `primary_path.usage_updated` | Full primary-path compatibility frames. |
| `primary_path.turn_started`, `primary_path.assistant_committed`, `primary_path.turn_annotation_changed`, `primary_path.label_changed`, `primary_path.changed` | Durable lifecycle and primary-path updates; an open inspector keeps the same record across completion. |

## Execution inspection endpoints

`GET /api/processes/:instanceId/turn-records/:turnRecordId/inspection?section=summary|trace|context|configuration` serves inspector evidence:

- `summary` avoids session-tree and immutable content reads.
- `trace` (and `GET /api/processes/:instanceId/turn-records/:turnRecordId/reasoning`) returns all recorded activity (`state: "live" | "committed"`, `throughEventSequence`) without a lookback limit; committed traces reconcile retained JSONL sessions with server operational events so pre-upload failures do not erase recorded activity.
- `context` and `configuration` load independently; requested entry, item, or boundary targets must belong to the same process and execution.

Process diagnostics capture related SQLite records and presentation fields before reading the retained session tree, so a concurrent mutation cannot mix SQLite states within one response. SQLite and session storage remain separate snapshots, not a single atomic read.

Deploy compatible `protocol`, `server`, SQLite schema, and `ui` artifacts together.
