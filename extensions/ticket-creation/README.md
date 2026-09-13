# Ticket creation

Provides the generic `ticket_creation_process`. Operators launch it from a durable parent result through the ticket-creation HTTP API. The server snapshots parent context, records a derived-process relation, exposes only the selected capability-marked integration tool, and gates the first external write for operator approval.

Ticket adapters register normal integration tools with `capability.kind: "ticket_creation"` and return `{ externalId, url, result? }`. Adapters may provide dynamic destinations. The launcher snapshots browser-safe destination summaries with the parent context but does not make the operator choose one before the child process starts. The child process asks only when the operator's issue description does not identify a destination. The server resolves that opaque choice into a fresh snapshot before approval and passes it to the tool as `ctx.ticketDestination`. Optional `agentContext` is untrusted prompt data and must not contain credentials.

The initial dialog contains only the operator's issue description and, when more than one adapter exists, the ticket system. Ticket refinement and destination clarification stay in the child process's normal UI.

Adapters must use the execution context idempotency key with `ensureWrite()` and reconcile ambiguous external outcomes before retrying.

The root export provides the process and `ticketCreationParamsCodec`. The codec
validates nested parent strings/results, artifact identifiers, excerpt focus,
actor fields and destination summaries. Existing parameters without destination
fields, with a resolved snapshot, or with a destination list remain supported.
Destination `data` is opaque JSON; its adapter validates its meaning. Captured
parent material is never reloaded from the parent during drafting.

For local development, import `LocalTicketAdapter` from
`@leitwerk-dev/ticket-creation/testing`. Configure its file, backend URL and
notebook destinations, then explicitly register `adapter.extension()` alongside
this extension. It contributes the normal `local_create_ticket` capability and
uses the server's durable external-write log with the execution idempotency key.
`injectLostResponse()` persists one ticket before failing the response. Replaying
the same key after restarting the adapter reconciles that ticket and records its
receipt without creating another. Serve the returned local receipt URLs from the
composition's controls. There is no production HTTP fallback.
