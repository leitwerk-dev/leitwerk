# Local handoff receipt

Open `index.html` directly. This is an offline operator experiment with synthetic transfer metadata and in-memory state. Reset restores the current walkthrough. No link, secret, network request or real archive is created.

The question: can operators distinguish link creation, server stream completion and client import acknowledgement without interpreting any of them as completion of the original process?

The receipt timeline exposes five separate observations: link creation, client claim, captured export boundary, server stream and local import acknowledgement. The boundary stays attached to the exported workspace and session even when the server later accepts another turn. Human handover notes require current receipt inspection; later events preserve drafts and mark earlier notes historical.

This differs from workspace readiness and completion closeout. It accounts for the specific server-to-local transfer boundary and the end of server visibility, rather than preparing work or asserting delivery of a finished process.

## Walkthroughs

1. **Import acknowledged:** claim a link, complete the server stream, receive the client report, then record human responsibility. The server process remains waiting.
2. **Bytes sent, acknowledgement unknown:** complete the stream without acknowledgement. The web cancel action leaves `awaiting_ack` unchanged; record a follow-up while import remains unknown.
3. **Cancel an incomplete stream:** observe partial bytes, cancel, and refuse an import acknowledgement. Keep the interruption note and partial-byte evidence.

Free play supports expired grants/deadlines, duplicate acknowledgements, stale note inspection, later server turns and refused actions. Claiming combines stable-boundary waiting, idle-worker removal and scanning into one synthetic step; the fixture starts waiting. A later manual server turn is refused while export is pending. Stream completion is a server observation, not proof that the client imported successfully. Acknowledgement reports import only; later local work uses local configuration and is outside this process.

Primary actions and guide controls retain readable white labels on a dark blue hover background.

## Existing seams and proposed additions

- `packages/server/src/session-transfer-service.ts`: `snapshotManifest` constructs export context; `presentSessionTransferOperation` exposes phase and manual-turn blocking; stream completion records compressed bytes and a digest before `awaiting_ack`; `acknowledge` and `cancelForWeb` preserve the existing phase rules.
- `packages/server/src/db/session-transfer-repo.ts`: grant and attempt identity, acknowledgement checks and consumed tombstones.
- `packages/server/src/routes/session-transfers.ts`: existing stream, acknowledgement and operator-cancel routes.
- `packages/session-transfer/src/format.ts`: phases and derived transfer states.
- `docs/process-workspace.md` and `docs/security.md`: archive scope, local import boundary and expiring bearer authority.

A longer-lived, non-secret receipt is a new evidence/retention contract. Persisting exact tree/turn boundary metadata, durable partial-stream observations and human notes would require new typed records, migrations and retention/redaction rules. The existing service does not already expose this complete receipt. This experiment adds no core implementation, inbound import, local monitoring, permission transfer or recall of sent bytes.

The source branch, commit, tree IDs, 93 entries and 24,576-byte archive are explicitly synthetic fixture metadata. Export includes workspace, session and manifest; managed credentials, Pi resources, tooling/dependency caches and unrelated storage are excluded. No bearer material is copied into the receipt.

## Validation and provisional learning

All three walkthroughs and real free-play checks passed in an isolated browser: wrong-refusal gating, export-time turn blocking, draft preservation, stale inspection, partial cancellation, expiration, repeated acknowledgement and immutable export identity after server advancement. Desktop 1440px/mobile 390px screenshots were opened and inspected; no horizontal overflow or browser errors were observed. Scoped Biome, extracted JavaScript syntax and diff checks passed. The detector ran once in degraded regex mode with no findings; computed contrast and selector analysis were unavailable.

The prototype collapses preparation phases, omits real tar/Zstandard validation and supports only one attempt per reset. It models neither a real local import nor retention cleanup.

Provisional learning: a useful handoff receipt needs three separate truths—server stream evidence, client import report and human responsibility. Cancellation or missing acknowledgement cannot undo bytes already sent, and later server work must not silently replace the exported boundary.
