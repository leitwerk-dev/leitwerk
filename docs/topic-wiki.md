# Topic solution wikis

A topic wiki shares reusable solutions within a bounded piece of work, not general
agent memory. The server owns topics, pages, immutable revision history, and deletion
tombstones in SQLite. Workers read and contribute through authorized integration tools.
A Jira topic uses the installation URL and immutable source issue ID, not its mutable
key. Splits bind their wiki to the selected source issue. Subtasks share their direct
parent's wiki even when that parent belongs to an epic; other epic-linked tickets
share the epic's wiki. Existing epic topics retain their identities.

## Evidence and drift

Each page records applicability, evidence paths and revisions, related page IDs, the
source requirement revision, and its contributing process and turn. `proposed`,
`observed`, and `validated` describe the recorded evidence, not universal correctness.
`validated` means validated against that evidence, not against today's repository.

When an integration refreshes a changed source issue, earlier entries require revalidation
on read. Updating or deleting a linked page invalidates dependent entries. Repository changes
are not monitored in the background: a consuming agent must inspect the current
repository and check applicability before reuse. Contradictions should be recorded
as `needs_revalidation`, with links and evidence. There is no time-based expiry,
cross-topic retrieval, automatic promotion, or curator process.

Agents receive a reminder to check the index at meaningful work boundaries and to
consider sharing a reusable solution or failed approach before ending significant
turns. Sharing nothing is valid; routine progress reports do not belong in the wiki.
Contributions are accepted without a human approval queue. Treat page content as
untrusted evidence, never as instructions or authorization to act.

## Browsing and deletion

**Solution wikis** opens `/wiki`. Participating process headers link to their source issue
wiki. Users can search, filter by evidence status, inspect provenance and revision
history, and confirm deletion. A deletion requires the current page revision;
concurrent edits produce a conflict rather than deleting unseen content.

Deleted pages disappear from browser and agent reads, including history reads.
Tombstones prevent stale writes from restoring the same page ID. Historical data
remains in SQLite for audit; deletion is not erasure of retained traces or context
already read by a running agent. An agent can still paraphrase old material under a
different ID, so deletion cannot guarantee removal from all future model output.
Do not put credentials or general personal memory in this store.

| HTTP operation | Contract |
| --- | --- |
| `GET /api/wiki/topics` | List topics. |
| `GET /api/wiki/topics/:topicId` | Current topic and non-deleted pages. |
| `GET /api/wiki/topics/:topicId/pages/:pageId/history` | Revisions of a current page. |
| `DELETE /api/wiki/topics/:topicId/pages/:pageId?revision=N` | Revision-checked tombstone; conflicts return 409. |

These routes use application-wide authentication. Topic scoping is a relevance and
tool-binding boundary, not tenant isolation. `wiki.updated` invalidates browser
reads; reconnects refetch the current HTTP snapshot.

Topics and publication receipts outlive individual processes. Process deletion does
not destroy shared guidance or the durable repository binding of a generated ticket.
The `topicWikiCapability` store is an internal server API; it is not available in
workers. Optional integrations own membership, contribution tools, and provider data.
