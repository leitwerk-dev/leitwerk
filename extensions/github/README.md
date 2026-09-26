# GitHub integration

Server-owned GitHub API profiles, pull-request state polling, and project-scoped
LLM tools. Tokens never enter workers. Reads cover issues, pull requests, reviews,
inline comments, Actions check runs, and releases. Pull-request creation, comments,
and updates use the durable external-write log.

```yaml
extensions:
  github:
    profiles:
      primary:
        api_base_url: https://api.github.com
        token: "..."
        bot_login: leitwerk-bot
```

The token needs repository contents and pull-request read/write access, issue
read/write access when issue tools are used, and Actions/checks read access. Git
checkout credentials are configured separately through `git-ssh`.

## Explicit integration composition

`GitHubClientLike` and `setupGitHubIntegration` let local compositions supply a
client while retaining shared tools and watchers. The optional provider clock
changes polling eligibility; it does not bypass event correlation.

Check observations record pending, success, and failure independently of event firing filters. Each observation names its revision; failed checks include names and run links. Refresh failures retain the last successful observation. Delayed writes carry the captured subscription generation. Existing firing filters and deduplication remain unchanged.

## Merge conflicts and outdated bases

Fresh pull-request metadata is polled every 30 seconds. Confirmed conflicts
(`mergeable: false`, `mergeable_state: dirty`) and clean but outdated branches
(`mergeable: true`, `mergeable_state: behind`) trigger the existing rebase flow.
The trigger uses GitHub’s merge eligibility state, not commit divergence: a PR
that the UI allows to merge (`clean`, `unstable`, or `has_hooks`) is left alone.
Behind evidence carries `reason: behind` and refreshes the base branch SHA because
GitHub’s PR base SHA can lag the current branch. Unknown or missing mergeability
is retried; blocked states and failing checks alone do not trigger a rebase.
Polling does not depend on checks or feedback API calls.
Evidence includes repository, PR, both branch names, head SHA, base SHA, and PR link.
Observations show both revisions and refresh errors. Before firing, the provider
rechecks the subscription generation and resolved configuration. Events deduplicate
by repository, PR, head, and base, so a new base can trigger with an unchanged head.
The process persists its last accepted key and validates evidence on consumption.

## Project binding

Server launch code writes a non-secret `metadata.github` object containing
`{ owner, repo, profile }` on each process project. Tools use only the project
selected and authorized by the server, never repository/profile tool arguments.
`GitHubProjectBinding` and `resolveGitHubProjectBinding` expose this contract.
Different projects in one process may use different profiles. Credentials remain
in the server integration; bindings contain only a profile identifier.

Legacy stored metadata can read its profile from `githubProfile` in process parameters.
Malformed explicit values fail instead of selecting another profile.
Capability, watcher, external-source and write identifiers retain their original
strings, including historical `@leitwerk-private/` prefixes. Package names do not
rename durable protocol identities.

## Local adapter

Import `LocalGitHubAdapter` from `@leitwerk-dev/github/testing` and supply its
`client()` through `setupGitHubIntegration`. Construct the adapter with an owned
`root` directory, a local `baseUrl`, and an optional `now` clock. Provider state
persists in `github.json`; unknown resources fail locally. Production registration
does not import this entrypoint. The adapter never falls back to HTTP.

`seed({ owner, name, files, defaultBranch })` creates or reuses real local Git
repositories. Reads refresh open PR heads, bases and mergeability. `merge` updates
the base with a fast-forward or real merge commit and rejects conflicts.
`addFeedback` accepts conversation, review and inline feedback.

`setChecks` records checks for a specific commit. A new PR head has pending checks
until that revision receives results. `publishRelease` takes a tag, commit ref and
an asset-name/content map; it verifies real ancestry through Git. Set
`state.failAfterPullRequestWrite` to simulate a lost PR-create response.

The integration exposes general release, asset and ancestry operations through
its server-owned client. Applications own asset selection and release-lock policy.

## Organization issue workflows

Set optional `allowed_organization: leitwerk-dev` on a profile to confine all
repository tools and client operations to that organization. Omitted restrictions
retain unrestricted profiles. Restricted tokens also need organization membership
read access. Discovery lists enabled organization repositories and checks the
latest trigger-label actor's current membership. A launch preparation check
rechecks the actor and label event after repository/identity preparation.

`githubIssueWatcherSource` retains `@leitwerk-public/github.issue`.
`githubExternal.checks`, `pullRequestFeedback`, `pullRequestTerminal` and
`issueCancelled` retain their separate `@leitwerk-public/github.*` contracts.
Feedback has independent conversation, review and inline cursors and a two-minute
default quiet period. Restricted actionable feedback requires a current member
author; edited bodies also require verified current editor membership from the
same GraphQL snapshot as the body. Bot delivery markers are excluded.

Terminal PR reconciliation takes precedence over source issue cancellation.
Checks correlate the captured head with a refreshed PR. Both observations and
events reject superseded subscriptions; generation-bound events are never queued
for a later subscription. The existing combined PR-state interface remains available.

Delivery tools preserve write identities and reconciliation markers across
restarts. Comment/reply reconciliation uses unfiltered receipt reads, so
membership changes cannot conceal a completed write. Reactions reconcile the bot's
existing eyes reaction. Issue finalization reconciles the desired patch before
retrying it. Release-lock selection stays outside this integration.

The local adapter supports `createIssue`, `setIssueLabel`, `setMembership`,
`editFeedback` and `failNextResponse`. Membership, label events, feedback edits,
write outcomes and Git history survive restart.

## Repository change process

Load [github-repo-change](../github-repo-change/README.md) to create changes from the
UI or labeled issues. Server-created integrations enumerate available profiles;
custom integrations may implement `profiles()` for launcher discovery.
`github_get_ci_diagnostics` verifies the selected process branches and current PR
head, then reads failed check annotations and Actions jobs. It returns at most ten
failed check details and ten failed job logs, with 64 KiB per log and explicit
truncation. Signed log downloads do not receive the API token. Actions read access
is required. Existing check-source callers remain compatible; the optional
`afterKey` suppresses a failure already consumed by a process.

Local adapter behavior does not establish live GitHub API compatibility.

## API support

The following exported declarations are `@public`:

- `@leitwerk-dev/github`: `GITHUB_CHECKS_KIND`, `GITHUB_ISSUE_CANCELLED_KIND`, `GITHUB_PR_FEEDBACK_KIND`, `GITHUB_PR_STATE_KIND`, `GITHUB_PR_TERMINAL_KIND`, `GitHubCheckSummary`, `GitHubGitIdentity`, `GitHubIntegration`, `GitHubIssue`, `GitHubPullRequest`, `GitHubRepository`, `default`, `githubExternal`, `githubIntegration`, `githubIssueWatcherSource`, `resolveGitHubProjectBinding`, `setupGitHubIntegration`.
- `@leitwerk-dev/github/testing`: `LocalGitHubAdapter`, `LocalGitHubOptions`, `LocalGitHubRepository`, `LocalGitHubState`.

Members have individual classifications; these exports do not make every member
public. Both `@public` and `@internal` APIs remain usable and fully typed. Source
annotations are authoritative; see the [SDK compatibility
policy](../../docs/process-sdk.md#api-compatibility).

### External-write replay

Writes follow the [shared reconciliation contract](../../docs/process-sdk.md#typed-external-writes).
Pull requests are matched by branch pair; comments and replies use hidden markers
within their repository and thread. Reaction recovery matches the bot's identity.
Update recovery compares requested fields, including normalized labels. Logged
replays return the current object without reapplying the patch.

GitHub polling uses the SDK reporter with live GitHub source kinds and generation forwarding. Conflict reporting uses `createConflictReporter(kind)` without creating another remote object.

The Settings repository refresh discovers repositories through configured profiles.
Provider origin and stable repository ID define identity; known clone URLs are
aliases. Execution uses retained identities without requiring external rediscovery.
The origin comes from the repository's web URL, including for GitHub Enterprise;
equal repository IDs on different servers remain distinct.
