# GitHub repository change

`@leitwerk-dev/github-repo-change` plans, implements, reviews, and publishes a
repository change as a GitHub pull request. Load `github`, `git-ssh`, `coding`,
and this extension on the server and worker. The extension is opt-in.

The UI launcher selects a server-owned GitHub profile, a visible repository, and
a requested change. Launch checks repository visibility and SSH read/write access,
pins the bot Git identity, and uses the default branch as the base. Replaying a UI
launch generates a new work branch. Plans and implementations require operator
approval before publication.

## Configuration

Configure API access in [github](../github/README.md) and checkout credentials in
[git-ssh](../git-ssh/README.md). The SSH credential defaults to the GitHub profile
name. Override it for future launches:

```yaml
extensions:
  github-repo-change:
    profile_bindings:
      team:
        ssh_credential_ref: repository-writer
process_configs:
  github_repo_change_process:
    watchers:
      use_leitwerk:
        enabled: true
        profile: team
        poll_interval: 30s
        repositories:
          include: [team/service]
        labels:
          trigger: use-leitwerk
          done: leitwerk-done
```

The issue watcher uses the integration's trigger-actor authorization and rechecks
it before launch. Issue launches use `leitwerk/issue-N`. Profile mappings cannot
be overridden through launcher input; existing instances retain resolved wiring.

## Delivery and recovery

The shared coding publication lifecycle commits and pushes the work branch, then
creates or reconciles one PR. It settles human feedback for two minutes, acknowledges
it, and starts a fresh repair turn. Replies and other provider writes reconcile
across retries. GitHub checks trigger repair only for the tracked request revision;
diagnostics include failed check annotations and bounded Actions job logs. Consumed
failure evidence is retained so rearming cannot repeatedly repair the same failure.
After three automatic CI cycles, the operator chooses retry, resume waiting, or
abort. Missing or successful checks do not complete the process.

Confirmed conflicts and GitHub's clean-but-behind condition use the shared rebase
implementation and the original-head push lease. Merge completes delivery; closing
an unmerged PR aborts it. An issue-origin merge removes the trigger, adds the done
label, comments, and closes the issue. Unmerged closure removes the trigger and
comments without closing the issue. Source cancellation aborts waiting delivery;
terminal PR reconciliation takes precedence. UI-origin processes never need a
source issue.

## Composition

The default extension requires Docker. Trusted local compositions can use
`createGitHubRepoChange({ docker: false })`; load exactly one variant. Both retain
`github_repo_change_process`. Custom GitHub integrations must supply `profiles()`
to expose profiles to the launcher. The factory owns its launcher configuration
and clears it when the server stops. Automatic merging, existing-PR adoption,
fork publication, and release delivery are not provided.
