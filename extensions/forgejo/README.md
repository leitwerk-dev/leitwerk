# Forgejo integration

Server-owned Forgejo API profiles, issue discovery, pull-request external sources, and workflow-focused LLM tools. API tokens never enter workers.

```yaml
extensions:
  forgejo:
    profiles:
      primary:
        base_url: https://git.example.test
        token: "..."
        bot_login: leitwerk-bot
    ticket_creation:
      enabled: true
      default_labels:
        - created-by-leitwerk
```

The extension targets the Forgejo 11 API. It resolves `/api/v1/user` and requires the authenticated login to match `bot_login` before deriving a non-secret Git identity. The identity uses the account's full name and `<login>@noreply.<Forgejo host>`. It reads conversation comments, submitted
reviews, and inline review comments. It can add `eyes` to comment feedback and reply
inside the originating inline review. Submitted reviews have no Forgejo reaction
endpoint; replies to them use the pull-request conversation. Mutating tools use
durable external-write identities.

Inline replies retain the source comment's review, file, diff side, line, and
line range. Forgejo uses these coordinates to group conversations; an old-side
comment's `original_position` must be sent as `old_position`, and
`extra_lines_count` must be preserved for range comments. Replies to different
lines in the same file therefore stay in their respective threads.

## Token permissions

For ticket creation, the configured token must have access to the selected repository
and must grant:

- repository metadata/read access, to list repositories and inspect the destination;
- issue read access, to list labels and reconcile an idempotent ticket write;
- issue write access, to create issues and missing default labels.

For scoped tokens, the relevant Forgejo scopes are `read:issue` and `write:issue`,
plus the repository/metadata read permission required by the Forgejo version. The
account must have access to the repository, and its issue tracker must be enabled.
Pull-request, Actions, package, and administration permissions are not required for
ticket creation alone.

## Issue watcher repository filters

Forgejo issue watchers may restrict discovery with `repositories.include` and
`repositories.exclude`, using exact `owner/name` values. An empty include list means
all repositories. Exclusions take precedence. Filtering occurs before issue reads and
process launch resolution.

## Ticket creation

`forgejo_create_issue` is a ticket-creation adapter. It declares `ticket_creation_process`
and its `create_ticket` entry turn, provided by the composed `ticket-creation` extension.
The server gathers browser-safe
summaries for all token-accessible, non-archived repositories with issues enabled
across configured profiles when it launches the child process. A failed profile
produces a warning without hiding repositories returned by healthy profiles. The child
process infers the repository from the operator's issue description or asks for a
choice in the normal process UI. The server resolves and snapshots the selected
repository immediately before approval. A rename, transfer, archive, or disabled issue
tracker invalidates the snapshot before the external write.

The agent supplies a non-empty title and Markdown body and may select existing label
names from the snapshot. Unknown agent-selected labels fail. Configured default labels
apply to every repository and are created when missing. The default set is
`created-by-leitwerk`; set `default_labels: []` to disable it.

Created issue bodies contain a hidden `leitwerk-ticket-write` marker. Retries search
all repository issues for that marker before writing, which reconciles requests that
succeeded remotely before the response or durable write record completed. The tool
returns `{ externalId, url, result }`. API tokens and adapter snapshot data remain
server-owned.

## Explicit integration composition

`ForgejoClientLike` describes the public client contract. Alternate compositions
can call `setupForgejoIntegration` with an implementation and an optional provider
clock. Tools, ticket approvals, durable writes and issue/PR polling remain shared.
Confirmed ticket readback after a lost response records the durable receipt even
when the original create response was unavailable.

## Merge conflicts

Fresh pull-request metadata is polled every 30 seconds. Only confirmed conflicts
trigger repair: `mergeable: false` (and `mergeable_state: dirty` on GitHub). Unknown
or missing values are retried; being behind, blocked, or failing checks is not a
conflict. Conflict polling does not depend on checks or feedback API calls.
Evidence includes repository, PR, both branch names, head SHA, base SHA, and PR link.
Observations show both revisions and refresh errors. Before firing, the provider
rechecks the subscription generation and resolved configuration. Events deduplicate
by repository, PR, head, and base, so a new base can trigger with an unchanged head.
The process persists its last accepted key and validates evidence on consumption.

## Project binding

Server launch code writes a non-secret `metadata.forgejo` object containing
`{ owner, repo, profile }` on each process project. Tools use only the project
selected and authorized by the server, never repository/profile tool arguments.
`ForgejoProjectBinding` and `resolveForgejoProjectBinding` expose this contract.
Different projects in one process may use different profiles. Credentials remain
in the server integration; bindings contain only a profile identifier.

Legacy stored metadata can read its profile from `forgejoProfile` in process parameters.
Malformed explicit values fail instead of selecting another profile.
Capability, watcher, external-source and write identifiers retain their original
strings, including historical `@leitwerk-private/` prefixes. Package names do not
rename durable protocol identities.

## Local adapter

Import `LocalForgejoAdapter` from `@leitwerk-dev/forgejo/testing` and supply its
`client()` through `setupForgejoIntegration`. Construct the adapter with an owned
`root` directory, a local `baseUrl`, and an optional `now` clock. Provider state
persists in `forgejo.json`; unknown resources fail locally. Production registration
does not import this entrypoint. The adapter never falls back to HTTP.

`seed({ owner, name, files, defaultBranch })` creates or reuses real local Git
repositories. Reads refresh open PR heads, bases and mergeability. `merge` updates
the base with a fast-forward or real merge commit and rejects conflicts.
`addFeedback` accepts conversation, review and inline feedback.

Ticket creation is enabled by default and requires the composed
`ticket_creation_process` with its `create_ticket` turn. Set
`ticket_creation.enabled: false` (or pass `enabled: false` in the explicit setup
configuration) to register Forgejo without ticket creation. Invalid enabled ticket
composition fails startup. Other Forgejo tools and polling remain available.

Set `state.failAfterIssueWrite` to simulate one lost issue-create response.
The provider retains the issue before throwing so the normal durable ticket tool
can reconcile its marker and record a receipt on retry.

Typed watcher lookup uses the source object supplied by the process definition.
When composing retained processes from another module instance, pass their source
as `setupForgejoIntegration`'s `options.issueWatcherSource`. The default is this
package's exported `forgejoIssueWatcherSource`; persisted source IDs remain unchanged.

## API support

The following exported declarations are `@public`:

- `@leitwerk-dev/forgejo`: `FORGEJO_ISSUE_CANCELLED_KIND`, `FORGEJO_PR_CONFLICT_KIND`, `FORGEJO_PR_FEEDBACK_KIND`, `FORGEJO_PR_TERMINAL_KIND`, `ForgejoClient`, `ForgejoGitIdentity`, `ForgejoIntegration`, `ForgejoIssue`, `ForgejoPullRequest`, `ForgejoRepository`, `default`, `forgejoExternal`, `forgejoIntegration`, `forgejoIssueWatcherSource`, `resolveForgejoProjectBinding`, `setupForgejoIntegration`.
- `@leitwerk-dev/forgejo/testing`: `LocalForgejoAdapter`, `LocalForgejoOptions`, `LocalForgejoRepository`, `LocalForgejoState`.

See the [SDK compatibility policy](../../docs/process-sdk.md#api-compatibility) for member classifications and support guarantees.
