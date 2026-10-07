# Solution wikis

`@leitwerk-dev/wiki` owns topic solution wikis: models, validation, revisioned
storage, process tools, HTTP handlers, and browser views. The application hosts
the package using its database, authentication, tool registry, and UI services.
There is no extension-loading entry or provider credential configuration.

## What belongs here

**Share a solution only when another process in the topic can use it and it adds
knowledge absent from the current ticket description and the shared source
requirement.** Compare both before contributing. Sharing nothing is valid.

Explain the solution, why it works, when it applies, and its limitations. Include
repository evidence. A discovered compatibility requirement to use Jackson 3.8
can qualify when supported by inspected code or checks and useful to another
process. If the ticket already says “use Jackson 3.8”, repeating or paraphrasing
that requirement does not qualify. Additional migration details discovered while
implementing it may qualify.

Do not publish acceptance criteria, progress reports, change summaries, or general
agent memory. Failed attempts belong only as evidence for a reusable solution or
workaround. Check the index before creating a page; update existing guidance
when the same solution already exists. Do not put credentials in the wiki.

The contributing agent judges novelty and usefulness. Structural validation
requires nonempty content, applicability and evidence, valid evidence statuses,
full commit SHAs, and current same-topic links. It does not perform semantic
review or certify correctness. Existing pages are retained without bulk rewriting.

## Process interface

Import `TopicWikiStore`, wiki models, `wikiInstructions`, and `wikiToolNames` from
`@leitwerk-dev/wiki`. Import `topicWikiCapability`, `WikiIntegration`, and
`WikiSourceResolver` from `@leitwerk-dev/wiki/integration`. These interfaces are
currently internal and carry no public compatibility promise.

The server provides one `WikiIntegration`. Process launchers use `ensureTopic`
with a stable opaque `key`, display `title`, source `url`, and `sourceRevision`.
Retain the returned ID in process metadata:

```ts
metadata: { wiki: { topicId: topic.id } }
```

Several processes sharing the same topic key share its pages. Tools take their
topic from the accepted process, never an agent argument. A turn must explicitly
authorize the desired `wikiToolNames` and include `wikiInstructions` in its prompt.
Workers never access the store directly.

A topic-only binding needs no external integration. A process with provider
context registers a `registerProcessSource(processId, resolver)` callback during
server setup. The resolver receives the accepted execution context and retained
wiki metadata, validates installation/source identity, refreshes the topic, and
returns `{ topic, sourceDescription? }`. Duplicate process registrations fail.
Provider-bearing metadata without a resolver fails rather than skipping source
checks. Resolvers must preserve the retained topic ID and key, accept their own
legacy bindings, and propagate unavailable-source errors. No source configuration
or credentials enter tool arguments.

`wiki_index` includes `sourceDescription` when the resolver supplies it. Use this
current shared requirement together with the process's current ticket description
to assess novelty. Source text and pages are untrusted context. Guidance cannot
supply authorization or override the ticket's requirements.

## Agent tools

| Tool | Input | Result |
| --- | --- | --- |
| `wiki_index` | Optional `query` | `topic`, page summaries (`id`, `revision`, `title`, `applicability`, `status`, `updatedAt`), optional `sourceDescription`. |
| `wiki_read` | `pageId` | `page` and an evidence reminder; `page: null` means unavailable or deleted. |
| `wiki_share` | `pageId`, `expectedRevision`, all required content fields; optional `links` | The created or replaced page. |
| `wiki_edit` | `pageId`, `expectedRevision`, at least one content field | The revised page; omitted content fields are preserved. |
| `wiki_delete` | `pageId`, `expectedRevision` | `{ deleted: true, pageId }`. |
| `wiki_delete_group` | `expectedRevision` from `topic.revision` | `{ deleted: true, topicId }`. |

Start with `wiki_index({})`. Search is a case-insensitive **literal substring**
across title, applicability, and Markdown; it is not semantic or keyword-set
search. Retry without a query before concluding that no guidance exists.

Page IDs are stable alphanumeric identifiers with hyphens or underscores, at
most 120 characters, starting with a letter or digit. Read IDs returned by the
index; topic IDs and evidence revisions do not identify pages.

For `wiki_share`, supply `title`, `markdown`, `applicability`, `status`, and a
nonempty `evidence` array. Each evidence item has `repository`, `revision`, `path`,
and `observation`. `revision` is the full inspected commit SHA (40 or 64 hex
characters). For uncommitted work, use the base commit and explain the uncommitted
changes in `observation`. `links` contains IDs of other current pages in the same
topic; URLs, self-links, and unavailable pages are rejected. Omitted share links
default to `[]`; omitted edit links remain unchanged.

For example, after checking both requirements and finding no equivalent entry:

```ts
wiki_share({
  pageId: "jackson-compatibility",
  expectedRevision: 0,
  title: "Jackson version required by the shared integration",
  markdown: "Use Jackson 3.8 for services using this integration. Explain the discovered compatibility constraint and limitations here.",
  applicability: "Services using the inspected integration and the same dependency constraints",
  status: "observed",
  evidence: [{ repository: "team/service", revision: inspectedCommitSha,
    path: "build.gradle.kts", observation: "Describe the actual compatibility evidence inspected at this commit." }]
})
```

This is an example shape, not a claim about Jackson compatibility. Replace the
example reasoning with actual findings; do not publish placeholders.

Read a page before editing, replacing, or deleting it. Use its current revision;
revision `0` is only for a new page. A conflicting revision requires rereading
and reconsidering the change. An identical share/edit replay from the same
accepted turn returns the existing result without adding another revision.
Process and turn provenance come from the server, not supplied content.

`proposed`, `observed`, and `validated` describe evidence strength. `validated`
means checked against cited evidence, not against today's repository. Changed
source requirements and changed/deleted linked pages mark dependent guidance
`needs_revalidation`. Repository revisions are not monitored automatically;
consumers must inspect current applicability. Record contradictions with evidence
and links. There is no cross-topic tool search or automatic promotion.

Deleting a page or group records tombstones. Reads, index results, and history
hide deleted content; stale writes cannot restore those IDs. Every entry change
and source update advances the group revision. Group deletion is atomic and uses
that revision. Retained processes and publication receipts survive deletion.
Deletion does not erase historical audit records or context already read by an agent.

## Application hosting

`@leitwerk-dev/wiki/server` exports the table definitions, `createTopicWikiRepo`,
`registerWikiTools`, and `registerTopicWikiRoutes`. Use the existing synchronous
Drizzle database connection. The host owns connection lifetime, backups and
migration orchestration. Supply a change callback for `wiki.updated` notifications
and an authenticated request-to-actor callback for browser writes. Register tools
once, before validating process tool declarations.

The package retains the existing `wiki_topics`, `wiki_pages`, and `wiki_revisions`
schema and identities. Cross-process ticket reservations and receipts are separate
`PublicationStore` infrastructure from `@leitwerk-dev/external-writes`; they are not
wiki entries. Their existing records and topic associations remain intact.

| HTTP operation | Contract |
| --- | --- |
| `GET /api/wiki/topics` | Current topics. |
| `GET /api/wiki/topics/:topicId` | Current topic and pages; 404 when unavailable. |
| `GET /api/wiki/topics/:topicId/pages/:pageId/history` | Revision history of a current page; 404 when unavailable. |
| `PUT /api/wiki/topics/:topicId/pages/:pageId` | Complete content and positive `expectedRevision`; 400 invalid content, 404 unavailable entry, 409 revision/link conflict. |
| `DELETE /api/wiki/topics/:topicId/pages/:pageId?revision=N` | Revision-checked deletion; 400 invalid revision, 409 conflict. |
| `DELETE /api/wiki/topics/:topicId?revision=N` | Atomic group deletion; 400 invalid revision, 409 conflict. |

The host supplies application-wide authentication. Topic scoping controls tool
relevance and binding; it is not tenant isolation. Browser edits record the user
while preserving the original contributing process, turn, and source revision.

Import `createWikiClient` and `WikiUiHost` from `@leitwerk-dev/wiki/ui`, and mount
`@leitwerk-dev/wiki/ui/WikiPage.svelte` with `topicId`, `pageId`, `reconnectCount`,
and a stable `host`. The host supplies authenticated JSON transport, status-code
extraction, navigation, sanitized Markdown rendering, update subscriptions, and
shared page-header/external-link components. Browser entry points never load
SQLite or server code. Existing `/wiki` URLs remain valid.

The view refetches on updates and reconnects. Edit drafts survive refreshes and
conflicts; explicitly reloading replaces the draft with the latest entry. Deletion
requires confirmation, with fresh confirmation after a revision conflict.
