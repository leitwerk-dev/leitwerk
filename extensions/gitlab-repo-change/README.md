# GitLab repository change

`@leitwerk-dev/gitlab-repo-change` plans, implements, simplifies, and publishes a
repository change as a new GitLab merge request. Load `gitlab`, `git-ssh`, `coding`,
and this extension on the server and worker. The extension is opt-in.

The UI launcher selects a GitLab profile, a visible project, and a requested change.
It selects a matching Git SSH profile, checks project visibility and SSH read/write
admission, pins the bot Git identity, and targets the default branch. Replaying a UI
launch generates a new work branch. Plan approval starts implementation and MR
publication automatically. The launcher offers unchecked **Skip plan approval**
and **Skip simplification** options and preserves both on relaunch. Skipping
approval still generates and retains a plan.

[Generated process graph](process.mmd). Dashed edges are external triggers; terminal
outcomes are separate from the ten registered turns.

## Configuration

Use a server-side [GitLab profile](../gitlab/README.md) for API access and a matching
[Git SSH profile](../git-ssh/README.md) for cloning and pushing. Configure issue
discovery on the process:

```yaml
process_configs:
  gitlab_repo_change_process:
    watchers:
      use_leitwerk:
        enabled: true
        profile: team
        git_ssh_profile: team
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

Human discussion feedback settles for two minutes. Shared GitLab maintenance
acknowledges it with an eyes reaction, invokes Address Feedback directly, and
reconciles discussion replies. CI
repair reads failed jobs and bounded traces for the current MR pipeline. Synthetic
merge pipelines must contain the tracked source revision; newer pending pipelines
supersede older terminal results. After three automatic CI cycles the operator
chooses retry, resume waiting, or abort. Successful or absent CI continues waiting.
Confirmed merge conflicts use the shared rebase implementation and original-head
push lease. Unknown mergeability does not trigger a repair.

Deliver executes only for initial publication and changed adjustments. Preparing
MRs, CI, target-head and label updates refresh durable observations without worker
allocation or turn records. A no-change repair acknowledges its feedback and resumes
observation without another Deliver execution. The workflow retains ten business
turns; maintenance adds none.

Published MRs receive `leitwerk-active`, retained while CI is green and later
feedback is awaited. Merge replaces it with `leitwerk-done`. Removing active aborts
this single-MR process and leaves the MR open. Running work and operator waits are
monitored; publication, replies, reactions and late worker outcomes are fenced after
removal. A remove/re-add pair ends the old activation. Restart adopts live bindings
and receipts while preserving cursors, budgets and history. Label-read failures retry
without cancellation. Closure and stopping do not add done.

Merge completes delivery. Unmerged closure aborts it. A source issue loses its
trigger, gains the done label, receives a comment, and closes after merge. Unmerged
closure removes the trigger and comments while leaving the issue open. Source
cancellation aborts waiting delivery, with terminal MR reconciliation taking
precedence. UI-origin processes never require a source issue.

## Composition

The default extension requires Docker. Trusted local compositions can use
`createGitLabRepoChange({ docker: false })`; load exactly one variant. Both retain
`gitlab_repo_change_process`. GitLab API tokens remain server-side. Git SSH
credential delivery is repository-scoped. Automatic merging, existing-MR adoption,
fork publication, and release delivery are not provided.

## Shared workflow

This process uses the [ten-turn workflow](../jira-gitlab-change/README.md#workflow)
from `coding`. Plan decisions offer approval or revisions with human comments.
Implementation, simplification analysis, simplification application, commit-message
generation, and publication then proceed automatically. The simplification analysis
covers staged, unstaged, and untracked changes and hands durable findings to the
separate application turn. Both turns run once before first publication.

For issue launches, `leitwerk-skip-simplification` is read immediately after
implementation. UI launches use the checkbox. A failed source lookup pauses for
retry; recovery reuses completed routing decisions. Later labels do not interrupt
simplification that already started. GitLab source issues do not use the Jira
plan-bypass label. Neither skip label replaces the watcher launch trigger.

Before deployment, finish or abort active instances using the removed plan-review,
implementation-review, implementation-approval, or simplification-approval turns.
Their history must be retained. GitHub and Forgejo use the same workflow and
upgrade boundary; provider-specific publication and CI semantics remain separate.
