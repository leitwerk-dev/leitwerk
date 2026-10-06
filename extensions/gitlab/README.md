# GitLab

## Ticket creation

Load `@leitwerk-dev/ticket-creation` and set:

```yaml
extensions:
  gitlab:
    ticket_creation:
      enabled: true
      default_labels: [created-by-leitwerk]
```

`gitlab_create_issue` discovers projects from configured profiles, excluding archived
projects and projects with issues disabled. The token needs API access and permission
to create issues and configured default labels in the destination. Optional labels
must already exist. Set `default_labels: []` to omit defaults; label names cannot
contain commas.

The normal draft process asks for approval before writing. Its snapshot pins the
installation, project ID and path. Renamed, transferred, disabled or repointed
destinations fail before writing. Retry reconciliation includes closed issues and
recovers lost create responses. Ticket creation defaults to disabled; enabling it
requires the ticket process to be loaded.

## Profiles and delivery

`@leitwerk-dev/gitlab` supplies GitLab v4 API access and repository-scoped HTTPS Git authentication from one server-owned profile. Load this optional extension on the server and worker.

```yaml
extensions:
  gitlab:
    profiles:
      example:
        base_url: https://forge.test
        token: env:GITLAB_TOKEN
        ignored_comment_users: [sonarqube]
        # Optional, when /user cannot provide a usable commit identity:
        # git_identity:
        #   name: Leitwerk Bot
        #   email: bot@example.net
```

`base_url` must be an HTTPS origin without credentials, a query or a fragment. Supply a personal, project or group token with `api` and `write_repository` scopes and permission to push the selected source branches. Tokens stay on the server except for the selected repository's authenticated `worker.start` delivery. No separate Git credential configuration is needed. Missing tokens, identity or permissions are configuration errors.

## Public interface

- `GitLabClientLike` defines project/group discovery, MR metadata and paginated changes, branches/commits, pipelines, failed jobs, bounded traces, bot identity and notes. `GitLabClient` implements it using HTTPS, pagination and bounded transient read retries. Errors omit response bodies and credentials. Writes are reconciled by their caller rather than blindly repeated.
- `gitlabIntegration` exposes `profiles()` and `client(profile)` through the SDK capability registry. `setupGitLabIntegration()` registers an explicit adapter for tools and external observations.
- Server setup also supplies `repositoryCatalog` for Settings. Opening Settings
  or a repository editor does not scan GitLab. Searches of at least two characters
  read one page of up to 100 matches per profile and cache repeated queries;
  concurrent identical searches share one request. **Refresh sources** explicitly
  loads a complete catalog, which subsequent searches filter locally. A failed
  refresh retains the last successful data. Server restart or integration
  reconfiguration starts a new cache. Saved selections use known metadata without
  remote reads; unknown names display the stable repository ID until found.
  Admission and delivery still read live project metadata and permissions through
  `client(profile)`.
- `listMergeRequestLabelEvents()` reads paginated label transitions with stable event IDs. `updateMergeRequestLabels()` applies `add_labels` and `remove_labels` without replacing unrelated labels.
- `registerGitLabMaintainedProcess()` registers a typed MR maintenance policy through
  the capability registry. One server service observes all registered processes,
  including running turns and operator waits. The process supplies its repair
  destinations, state adapters, completion policy and optional retry budget.
- `gitlabRepositoryCredentials(profile, projects)` derives internal credential references. The core authorizes their HTTPS origin and exact repository path against the process projects.
- `selectGitLabProjects()` expands exact includes and groups, including subgroups, then applies exclusions. Includes form a union; stable project IDs remove duplicates. An explicit include or `all_accessible: true` is required.
- `observeMergeRequest()` selects the newest pipeline associated with the current MR source revision. Synthetic merge commits must contain that head as a parent. With no matching MR pipeline, it falls back to the current source branch's push pipeline. A newer pending result supersedes older terminal results. The observation includes GitLab's `has_conflicts`, `merge_status` and `detailed_merge_status`, plus `targetHead` read from the current target branch (not the historical diff base). Closed MRs do not require branch or pipeline reads.
- `gitLabMergeRepairReason(mr)` identifies explicit conflict and `need_rebase` evidence. `gitLabMergeabilityPending(mr)` distinguishes asynchronous checks; approvals, discussions and generic merge blocking are not Git conflict evidence.
- `gitlabExternal.mergeRequest()` reports MR closure/merge, source/target project and branch changes, current heads, mergeability and CI observations. Mergeability or target changes wake an idle process even when its source SHA and successful pipeline are unchanged. Its `afterKey` is the previous `observationKey()`. An optional `wakeAt` timestamp permits recovery timers without retaining a worker. Poll failures back off from 30 seconds to five minutes and surface diagnostics.

## Commit-pinned repository inspection

`gitlab_inspect_project`, `gitlab_repository_tree`, `gitlab_repository_file`, and
`gitlab_code_search` require a GitLab process project binding. Tree, file, and
search calls require a full commit ID as `ref`; branches are rejected. Tokens
stay on the server unless the process explicitly declares repository credentials.

`gitlab_code_search({ projectKey, ref, search, page?, perPage? })` uses
project-scoped basic blob search. It returns paths, snippets, starting lines, the
requested revision/page, and `nextPage` (`null` when complete). Defaults are page
1 and 20 results; at most 100 results are returned per page. Follow continuation
pages and read the files for complete evidence. Access errors, unavailable search,
invalid responses, and cancellation fail the call; they are never empty matches.

## Project-bound tools

Project metadata binds tools to `{ gitlab: { profile, projectId, iid } }`. Each call requires an authorized process project. Available tools are `gitlab_observe_merge_request`, `gitlab_get_changes`, `gitlab_get_identity`, `gitlab_list_failed_jobs`, `gitlab_get_job_trace`, `gitlab_comment`, and `gitlab_reply`. Job and pipeline reads verify membership in the bound MR's current pipeline. Traces cap individual reads at 256 KiB; truncation is explicit.

Comments require a stable business `writeKey`. `ensureGitLabComment()` combines it with the instance, project, MR and process IDs, appends a hidden marker, and uses `ctx.externalWrites.ensure()`. It searches remote notes before creating a comment and after an uncertain write. `gitlab_reply` additionally requires `discussionId` and reconciles within that discussion. Repeating a call after losing either the response or the local write-log record reuses the same remote comment.

The MR external source can also observe review feedback using `feedback: { afterId, since, quietPeriodMs }`. It reads paginated discussions, preserving inline file/line context, and excludes system/resolved notes, Leitwerk-generated comment markers and accounts flagged as bots. Human comments by the authenticated PAT owner remain actionable. Each new unseen note resets the trailing quiet period; a mature batch wakes the process even when the MR revision and CI status are unchanged. The process owns the durable cursor and decides when feedback is consumed. The provider recomputes timing from note timestamps after restart.

Each profile may configure `ignored_comment_users`, defaulting to `[]`. Usernames
are case-insensitive and accept a leading `@`. The shared feedback reader excludes
those authors for every workflow using the profile, before feedback settling and
cursor selection. Their general comments, inline comments and replies do not trigger
work or acknowledgements. Other users' replies in the same discussion remain
actionable; mentioning an ignored account does not exclude a comment. Profile edits
apply after server restart; executing turns keep their captured inputs. CI and
conflict observations remain available.

`ensureGitLabSeenReaction()` lets a process acknowledge an authorized MR comment with an eyes reaction. It reconciles the authenticated bot's reaction and records it with `ctx.externalWrites.ensure()`. Other users' eyes reactions do not suppress the bot's acknowledgement; retries and restarts do not duplicate it. The calling process owns selection and lifecycle checks.

The extension contains no Renovate selection or repair policy. `./testing` exports a persistent `LocalGitLabAdapter` with real local repository ancestry for integration tests.

## Shared MR maintenance

Opt in during `setupServer`. Declare external edges using
`gitlabMaintenanceSource()` and register their identities:

```ts
registerGitLabMaintainedProcess(api, {
  processId: process.id,
  paramsCodec: process.paramsCodec,
  stateCodec: process.stateCodec,
  idleTurnId: "deliver_change",
  destinations: {
    feedback: "maintenance_feedback",
    conflict: "maintenance_conflict",
    ci: "maintenance_ci",
  },
  observe: repairPolicy.observe,
  stopped: repairPolicy.stopped,
  terminal: repairPolicy.terminal,
  completion: repairPolicy.completion,
  complete: repairPolicy.complete,
});
```

Bindings default to each process project's `gitlab` metadata. `bindings` can
provide explicit MR targets. `settings` supplies the consumed feedback cursor,
activation receipt, polling interval and quiet period; the quiet period defaults
to two minutes. `assess`, `eligible` and `canWrite` retain process-specific admission
rules. `observe` returns state and an optional destination key (`feedback`,
`conflict`, `ci`) or an additional declared external action. The service fires the
existing edge; ordinary observations allocate no worker and create no turn record.
`currentBinding` identifies a selected repair or operator decision so removing a
different MR's label preserves that business position. Interrupted repairs on
remaining MRs retain their staged work and repair budgets.

`messages` supplies retry-safe discussion replies or comments. `settled` advances
business acknowledgement state after those writes succeed. `completion` determines
the terminal lifecycle without remote writes. `complete` delivers process-specific
terminal writes and retries them after the process ends. Optional `retry.maxAttempts`
bounds generic infrastructure retries without consuming the process's repair budget.

Taking responsibility adds `leitwerk-active`. Green CI keeps maintenance active for
later feedback. Removing the label ends that MR's activation and leaves the MR open.
Other bindings continue; a single stopped, unmerged binding aborts its process.
Remove/re-add pairs between polls end the old activation. Ownership is rechecked
before publication, replies and reactions; late worker outcomes are fenced.
Label-read failures produce retry diagnostics and do not cancel maintenance.

Merged MRs lose `leitwerk-active` and gain `leitwerk-done`. Unmerged closure and
stopping remove active without adding done. Label writes preserve unrelated labels
and reconcile lost responses. Startup adopts live bindings and existing activation
receipts, retaining feedback cursors, budgets, selected turns and historical records.
Processes retain their own reactivation admission and partial-completion rules.

The shared publication adapter used by Jira and GitLab repository changes registers
this policy. Settled feedback and actionable conflicts invoke Address Feedback
directly; failed current-revision CI invokes Fix CI. Changed work returns to Deliver.
A no-change outcome acknowledges its batch and resumes observation without another
Deliver execution. Label, target-head and mergeability updates do not replay a
handled pipeline failure. A new pipeline or an observed running-to-failed retry
remains actionable. Maintenance adds no business turns.

## Creating repository changes

Load [gitlab-repo-change](../gitlab-repo-change/README.md) for UI and labeled-issue
change workflows. Repository-only metadata `{ gitlab: { profile, projectId } }`
permits identity resolution and MR creation. `gitlab_ensure_merge_request` validates
the process branches, reconciles its remote marker through the durable write log,
and pins `iid` through server project persistence. Existing MR-bound metadata and
tool calls remain supported. MR-only tools reject missing bindings.

The GitLab repository change process uses SSH clone URLs and `git-ssh` profiles.
The [Jira GitLab change](../jira-gitlab-change/README.md) process supports HTTPS with
the GitLab profile's token, or explicitly selected SSH profiles. HTTPS mappings need
no separate SSH credentials. Jira API tokens stay on the server. Supplying `origin`
in the GitLab binding pins the installation: tool calls fail if its profile is repointed.

Source-issue tools require the launch-pinned `issueIid`. Issue updates, comments,
labels, MR creation, and feedback acknowledgements reconcile uncertain writes.
`gitlab_list_merge_request_feedback` and `gitlab_acknowledge_feedback` expose the
existing discussion and seen-reaction operations as project-bound tools.

The issue watcher uses exact project/group selection and rechecks eligibility at
launch. The MR source accepts optional `delivery` tracking to emit settled feedback,
confirmed conflict evidence, and an observation cursor alongside existing MR and CI
facts. Existing source callers retain their event kind and observation behavior.
HTTPS preflight performs repository reads and a dry-run feature-branch push without
putting credentials in URLs or command arguments.

`createGitLabPublicationAdapter()` shares publication and repair operations between
the GitLab and Jira processes. `gitlabExternal.mergeRequests()` observes coordinated
repositories through the same MR observation contract, retaining each repository's
`projectKey`, cursor, source revision, feedback settling, and repair evidence.

## API support

The following exported declarations are `@public`:

- `@leitwerk-dev/gitlab`: `GitLabDeliveryObservation`, `GitLabIssueWatcherEvent`, `gitlabIssueExternalId`, `gitlabIssueWatcherSource`, `GitLabDiff`, `GitLabFeedback`, `GitLabIdentity`, `GitLabIntegration`, `GitLabJob`, `GitLabMergeRequest`, `GitLabObservation`, `GitLabProject`, `GitLabRepositoryCatalog`, `GitLabSelection`, `default`, `ensureGitLabSeenReaction`, `gitLabFeedbackReadyAt`, `gitlabExternal`, `gitlabIntegration`, `gitlabRepositoryCredentials`, `observationKey`, `observeMergeRequest`, `parseGitLabSelection`, `pendingGitLabFeedback`, `resolveGitLabBinding`, `selectGitLabProjects`.
- `@leitwerk-dev/gitlab/testing`: `GitLabClientLike`, `GitLabMergeRequest`, `GitLabPipeline`, `GitLabProject`, `LocalGitLabAdapter`, `setupGitLabIntegration`.

The maintained-process API also supports `registerGitLabMaintainedProcess`,
`gitlabMaintenanceSource`, `gitlabMaintenance`, `GITLAB_MAINTAINED_KIND`,
`GITLAB_ACTIVE_LABEL`, `GITLAB_DONE_LABEL` and the exported
`GitLabMaintainedBinding`, `GitLabMaintainedProcess`, `GitLabMaintenance*` policy,
context, event, message, record, destination, retry and settings types.

Members have individual classifications; these exports do not make every member
public. Both `@public` and `@internal` APIs remain usable and fully typed. Source
annotations are authoritative; see the [SDK compatibility
policy](../../docs/process-sdk.md#api-compatibility).

### External-write replay

Writes follow the [shared reconciliation contract](../../docs/process-sdk.md#typed-external-writes).
Comment recovery includes closed merge requests and completed discussions. A logged
comment or reaction that cannot be recovered fails without repeating the write.

The Settings repository refresh discovers repositories through configured profiles.
Provider origin and stable repository ID define identity; known clone URLs are
aliases. Execution uses retained identities without requiring external rediscovery.
