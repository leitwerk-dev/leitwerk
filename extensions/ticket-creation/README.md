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
`injectLostResponse()` persists one ticket before losing the adapter response. The tool reconciles
that ticket and records its receipt without creating another. If receipt recording
is interrupted, replay the same execution key after restarting. Serve the returned local receipt URLs from the
composition's controls. There is no production HTTP fallback.

## Integration coverage

`src/forgejo-ticket.integration.test.ts` composes this process with the production
Forgejo tool registration, a local Forgejo adapter, file-backed SQLite, and
scripted in-process workers. It seeds a retained parent artifact instead of
running an unrelated repository-change workflow. It does not import the sandbox.

The former `tests/e2e/sandbox/providers.e2e.test.ts` scenario is split by contract:

| Contract | Coverage |
| --- | --- |
| Public providers registered once, no private extension | `tests/integration/composition/public-extension-catalog.integration.test.ts`; builds the public catalog without starting an app |
| Issue watcher discovers a repository-change process | Existing `tests/e2e/sandbox/forgejo-workflows.e2e.test.ts`, “source discovery is durable and merge finalizes the issue once” |
| Approval feedback revises the draft and retains its destination; decline writes nothing | `src/forgejo-ticket.integration.test.ts`, approval feedback and decline case |
| Accepted ticket reconciles a lost provider response into one issue and receipt | `src/forgejo-ticket.integration.test.ts`, lost-response case |
| Repeated ticket launch returns the same child after restart | Same lost-response case; reopens SQLite and reconstructs the adapter and app, then compares the child, receipts, and issues |
| Local receipt URL remains available after reload | `sandbox/tests/provider-controls.integration.test.ts` |

The restart case now covers graceful app shutdown with approval pending, Retry
from the parked error turn, and another restart after completion. It does not
simulate abrupt process death. Generic request validation and launch idempotency
remain server-owned. This split changes test ownership and failure isolation,
not production behavior.

The former `tests/e2e/sandbox/tickets.e2e.test.ts` scenarios have these replacements:

| Contract | Coverage |
| --- | --- |
| Parent edits do not change captured ticket context | `src/forgejo-ticket.integration.test.ts`: adds a newer durable parent result and changes the prompt; compares the child's context before and after restart/Retry |
| Pending approval survives shutdown; interrupted turn parks for Retry | Same integration test: retains the approval record, observes `create_ticket/error`, retries over HTTP, and verifies the destination before acceptance |
| Lost response produces one receipt, retained external identity, and no duplicate child after another restart | Same integration test with the Forgejo adapter; `src/testing.test.ts` separately covers local-adapter response loss and write-log recovery |
| Destination question precedes approval; feedback revises the draft; decline writes nothing | Same integration file: real question and approval HTTP handlers, with two available destinations and a scripted worker |
| Retained leaf ownership and excerpt validation | `packages/server/src/routes/ticket-creation.test.ts`: real repositories and HTTP handlers reject foreign/missing artifacts and invalid excerpts, and pass a normalized historical excerpt to the launch coordinator seam |
| Local ticket receipt URL is served from persisted state | `sandbox/tests/notebook-ticket-controls.integration.test.ts`: real Fastify control registration, with no worker or repository workflow |

Artifact HTTP tests do not execute the ticket worker. Admission, worker approval,
and external receipt persistence remain exercised by the extension integration
tests. Notebook control tests do not claim ticket-write or recovery coverage.
