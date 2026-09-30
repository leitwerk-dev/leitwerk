# Jira epic splitting

`@leitwerk-dev/jira-epic-split` creates one reviewed Story or Task per applicable
GitLab repository. It does not change repository code. Load `jira`, `gitlab`,
`git-ssh`, `coding`, `jira-gitlab-change`, and this opt-in extension.

Start **Jira Epic Split** in the UI with an open epic, explicit GitLab group or
project paths, exclusions, and Jira/GitLab/SSH profiles. Groups include subgroups;
exclusions take precedence. Archived repositories are excluded during discovery.
Scopes over 500 repositories must be narrowed. API tokens stay on the server.
SSH credentials authorize full clones only when `checkout_repository` is called.
Inspection prompts forbid changes, but shell access is not a read-only sandbox.

The Jira token needs issue creation, component and create-metadata reads, and label
updates. Configure the Epic Link field when schema discovery is ambiguous; see the
[Jira integration](../jira/README.md). Creation uses Data Center REST v2, not Jira Cloud.

## Workflow

| Turn | Work |
| --- | --- |
| `read_epic` | Capture the requirement and its revision. |
| `discover_candidates` | Decide for every scoped repository; retain exclusion reasons. |
| `assess_repository` | Sequential mapped LLM assessment, with GitLab reads and optional checkout. |
| `prepare_review` | Resolve component mappings, check current repository heads, publish a review batch. |
| `batch_review` | Approve, exclude repositories, override Task types/labels, revise, or refresh mappings. |
| `revise_drafts` | Reinspect and revise unpublished drafts from operator feedback. |
| `publish_tickets` | Create approved tickets with receipts and exact repository bindings. |
| `complete_split` | Publish the final dispositions and ticket links. |

Assessments distinguish applicable, already compliant, not applicable, and unresolved.
Applicable drafts include evidence, an inspected commit, and concrete acceptance
criteria. Missing access is unresolved, not proof that a repository is irrelevant.
The batch is a standard published Markdown product and operator form, not a custom UI.

In **Settings → Jira components**, map repositories to their GitLab and SSH profiles.
Created tickets receive every matching component in the epic's Jira project. An
unmapped or unresolved row stays pending; other approved rows can publish. Refresh
after adding mappings. Requirement or repository-head changes need reassessment.
Profile/clone/default-branch identity changes or moving the epic to another Jira project
require a new split. Published tickets
are retained, never silently edited. Finish without remaining tickets explicitly
excludes pending rows.

Labels start empty unless supplied by the operator or watcher configuration.
`use-leitwerk` is added only when explicitly selected at review or launch. It is
applied after the durable receipt is saved, making the existing Jira change watcher
eligible to launch work. No process directly spawns another process. The generated
ticket retains its exact repository even when a component maps to several repositories.

## Watcher

The dedicated label is `leitwerk-epic-split`, not `use-leitwerk`:

```yaml
process_configs:
  jira_epic_split_process:
    watchers:
      epic_split:
        enabled: true
        jiraProfile: team
        jiraProjects: ['10000']
        gitlabProfile: team
        sshProfile: team
        groups: platform
        projects: ''
        excludeGroups: platform/archived
        excludeProjects: platform/legacy
        issueType: Story
        labels: ''
        pollInterval: 30s
```

Group/project fields accept comma- or whitespace-separated exact paths. The watcher
deduplicates by Jira installation and epic ID and leaves the source label unchanged.
It always pauses at batch review before creating tickets.

## Recovery and shared solutions

Each Jira POST includes a stable `leitwerk-split-<digest>` marker. A durable reservation
precedes the POST; an uncertain result cannot issue another POST while Jira search
lags. Generic retry reconciles the marked issue or retained receipt. Known rejected
requests can retry after configuration is corrected. If the outcome stays uncertain,
an operator must locate the marked issue; if none exists, manually create the intended
ticket with that marker and epic link, then retry. Never remove a reservation merely
because search currently returns no result. Missing required Jira fields need project
defaults; this process does not guess custom-field values.

Component mappings, epic revision, and repository evidence are checked again before
new writes. Receipts reconcile independently of subsequent requirement or repository
changes; an unperformed change trigger still requires current approval. Duplicate marker
matches or changed ticket bindings require reconciliation.
Successful trigger receipts persist independently of process cleanup and prevent
reapplying a consumed `use-leitwerk` label.

The splitter and newly launched Jira changes belonging to the same epic share a
[topic solution wiki](../../docs/topic-wiki.md), including changes from manually
created tickets. Processes keep independent execution trees. The wiki shares only
reusable findings with applicability and revisioned evidence; it is not general memory.
