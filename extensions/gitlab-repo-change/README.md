# GitLab repository change

`@leitwerk-dev/gitlab-repo-change` plans, implements, reviews, and publishes a
repository change as a new GitLab merge request. Load `gitlab`, `coding`, and this
extension on the server and worker. The extension is opt-in.

The UI launcher selects a GitLab profile, a visible project, and a requested change.
It checks project visibility and HTTPS Git read/write admission, pins the bot Git
identity, and targets the default branch. Replaying a UI launch generates a new
work branch. Planning and implementation require operator approval.

## Configuration

Use the same [GitLab profile](../gitlab/README.md) for API and HTTPS repository
access. No separate Git SSH profile is required. Configure issue discovery on the
process:

```yaml
process_configs:
  gitlab_repo_change_process:
    watchers:
      use_leitwerk:
        enabled: true
        profile: team
        poll_interval: 30s
        projects:
          include: [team/service]
          exclude: []
        groups:
          include: [team/libraries]
          exclude: []
        labels:
          trigger: use-leitwerk
          done: leitwerk-done
```

Project and group includes form a union; groups include subgroups, exclusions win,
and project IDs remove duplicates. An explicit include or `all_accessible: true`
is required. Trigger and done labels must differ and contain no comma. The watcher
rechecks that the source issue remains open and eligible before creating a process.
Issue launches use `leitwerk/issue-N`; their durable identity includes the GitLab
origin, project ID, and issue IID.

## Delivery and recovery

The shared coding lifecycle commits and pushes, creates or reconciles one MR, and
waits for feedback, native CI, conflicts, or a terminal outcome. Repository metadata
starts with `{ profile, projectId }`; the server pins the MR `iid` after creation.
A lost creation response or a restart before binding recovers the same request.
Existing MR-bound integration tools still require the pinned IID.

Human discussion feedback settles for two minutes. Delivery acknowledges it with
an eyes reaction, revises in a fresh turn, and reconciles discussion replies. CI
repair reads failed jobs and bounded traces for the current MR pipeline. Synthetic
merge pipelines must contain the tracked source revision; newer pending pipelines
supersede older terminal results. After three automatic CI cycles the operator
chooses retry, resume waiting, or abort. Successful or absent CI continues waiting.
Confirmed merge conflicts use the shared rebase implementation and original-head
push lease. Unknown mergeability does not trigger a repair.

Merge completes delivery. Unmerged closure aborts it. A source issue loses its
trigger, gains the done label, receives a comment, and closes after merge. Unmerged
closure removes the trigger and comments while leaving the issue open. Source
cancellation aborts waiting delivery, with terminal MR reconciliation taking
precedence. UI-origin processes never require a source issue.

## Composition

The default extension requires Docker. Trusted local compositions can use
`createGitLabRepoChange({ docker: false })`; load exactly one variant. Both retain
`gitlab_repo_change_process`. Credentials remain in the owning integration except
for the existing repository-scoped worker Git credential delivery. Automatic
merging, existing-MR adoption, fork publication, and release delivery are not provided.
