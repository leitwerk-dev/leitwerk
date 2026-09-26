# GitLab

`@leitwerk-dev/gitlab` supplies GitLab v4 API access and repository-scoped HTTPS Git authentication from one server-owned profile. Load this optional extension on the server and worker.

```yaml
extensions:
  gitlab:
    profiles:
      example:
        base_url: https://forge.test
        token: env:GITLAB_TOKEN
        # Optional, when /user cannot provide a usable commit identity:
        # git_identity:
        #   name: Leitwerk Bot
        #   email: bot@example.net
```

`base_url` must be an HTTPS origin without credentials, a query or a fragment. Supply a personal, project or group token with `api` and `write_repository` scopes and permission to push the selected source branches. Tokens stay on the server except for the selected repository's authenticated `worker.start` delivery. No separate Git credential configuration is needed. Missing tokens, identity or permissions are configuration errors.

## Public interface

- `GitLabClientLike` defines project/group discovery, MR metadata and paginated changes, branches/commits, pipelines, failed jobs, bounded traces, bot identity and notes. `GitLabClient` implements it using HTTPS, pagination and bounded transient read retries. Errors omit response bodies and credentials. Writes are reconciled by their caller rather than blindly repeated.
- `gitlabIntegration` exposes `profiles()` and `client(profile)` through the SDK capability registry. `setupGitLabIntegration()` registers an explicit adapter for tools and external observations.
- `gitlabRepositoryCredentials(profile, projects)` derives internal credential references. The core authorizes their HTTPS origin and exact repository path against the process projects.
- `selectGitLabProjects()` expands exact includes and groups, including subgroups, then applies exclusions. Includes form a union; stable project IDs remove duplicates. An explicit include or `all_accessible: true` is required.
- `observeMergeRequest()` selects the newest pipeline associated with the current MR source revision. Synthetic merge commits must contain that head as a parent. With no matching MR pipeline, it falls back to the current source branch's push pipeline. A newer pending result supersedes older terminal results. The observation includes GitLab's `has_conflicts`, `merge_status` and `detailed_merge_status`, plus `targetHead` read from the current target branch (not the historical diff base). Closed MRs do not require branch or pipeline reads.
- `gitLabMergeRepairReason(mr)` identifies explicit conflict and `need_rebase` evidence. `gitLabMergeabilityPending(mr)` distinguishes asynchronous checks; approvals, discussions and generic merge blocking are not Git conflict evidence.
- `gitlabExternal.mergeRequest()` reports MR closure/merge, source/target project and branch changes, current heads, mergeability and CI observations. Mergeability or target changes wake an idle process even when its source SHA and successful pipeline are unchanged. Its `afterKey` is the previous `observationKey()`. An optional `wakeAt` timestamp permits recovery timers without retaining a worker. Poll failures back off from 30 seconds to five minutes and surface diagnostics.

## Project-bound tools

Project metadata binds tools to `{ gitlab: { profile, projectId, iid } }`. Each call requires an authorized process project. Available tools are `gitlab_observe_merge_request`, `gitlab_get_changes`, `gitlab_get_identity`, `gitlab_list_failed_jobs`, `gitlab_get_job_trace`, `gitlab_comment`, and `gitlab_reply`. Job and pipeline reads verify membership in the bound MR's current pipeline. Traces cap individual reads at 256 KiB; truncation is explicit.

Comments require a stable business `writeKey`. `ensureGitLabComment()` combines it with the instance, project, MR and process IDs, appends a hidden marker, and uses `ctx.externalWrites.ensure()`. It searches remote notes before creating a comment and after an uncertain write. `gitlab_reply` additionally requires `discussionId` and reconciles within that discussion. Repeating a call after losing either the response or the local write-log record reuses the same remote comment.

The MR external source can also observe review feedback using `feedback: { afterId, since, quietPeriodMs }`. It reads paginated discussions, preserving inline file/line context, and excludes system/resolved notes, Leitwerk-generated comment markers and accounts flagged as bots. Human comments by the authenticated PAT owner remain actionable. Each new unseen note resets the trailing quiet period; a mature batch wakes the process even when the MR revision and CI status are unchanged. The process owns the durable cursor and decides when feedback is consumed. The provider recomputes timing from note timestamps after restart.

`ensureGitLabSeenReaction()` lets a process acknowledge an authorized MR comment with an eyes reaction. It reconciles the authenticated bot's reaction and records it with `ctx.externalWrites.ensure()`. Other users' eyes reactions do not suppress the bot's acknowledgement; retries and restarts do not duplicate it. The calling process owns selection and lifecycle checks.

The extension contains no Renovate selection or repair policy. `./testing` exports a persistent `LocalGitLabAdapter` with real local repository ancestry for integration tests.

## Creating repository changes

Load [gitlab-repo-change](../gitlab-repo-change/README.md) for UI and labeled-issue
change workflows. Repository-only metadata `{ gitlab: { profile, projectId } }`
permits identity resolution and MR creation. `gitlab_ensure_merge_request` validates
the process branches, reconciles its remote marker through the durable write log,
and pins `iid` through server project persistence. Existing MR-bound metadata and
tool calls remain supported. MR-only tools reject missing bindings.

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

## API support

The following exported declarations are `@public`:

- `@leitwerk-dev/gitlab`: `GitLabDeliveryObservation`, `GitLabIssueWatcherEvent`, `gitlabIssueExternalId`, `gitlabIssueWatcherSource`, `GitLabDiff`, `GitLabFeedback`, `GitLabIdentity`, `GitLabIntegration`, `GitLabJob`, `GitLabMergeRequest`, `GitLabObservation`, `GitLabProject`, `GitLabSelection`, `default`, `ensureGitLabSeenReaction`, `gitLabFeedbackReadyAt`, `gitlabExternal`, `gitlabIntegration`, `gitlabRepositoryCredentials`, `observationKey`, `observeMergeRequest`, `parseGitLabSelection`, `pendingGitLabFeedback`, `resolveGitLabBinding`, `selectGitLabProjects`.
- `@leitwerk-dev/gitlab/testing`: `GitLabClientLike`, `GitLabMergeRequest`, `GitLabPipeline`, `GitLabProject`, `LocalGitLabAdapter`, `setupGitLabIntegration`.

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
