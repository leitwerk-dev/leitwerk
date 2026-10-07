# Jira Data Center

## Ticket creation

Load `@leitwerk-dev/ticket-creation` and set:

```yaml
extensions:
  jira:
    ticket_creation:
      enabled: true
      default_labels: [created-by-leitwerk]
```

`jira_create_issue` discovers creatable projects and non-subtask issue types through
the paginated REST v2 project/issue-type metadata endpoints (Jira 8.4 and later),
not the bulk `createmeta` endpoint removed in Jira 9. The configured PAT needs Browse Projects and Create Issues
permissions. Required custom fields and allowed values are included in the drafting
context. The draft may supply additional fields by metadata field ID, but cannot
override its server-pinned project or issue type. Unknown fields and missing required
values fail without creating an issue. Labels cannot contain spaces; use
`default_labels: []` to omit defaults. Empty labels are omitted from the create
payload. A destination whose create screen excludes Labels rejects configured
default labels before approval; requested labels must also be supported by that
screen.

The normal approval flow supports creation, revision and discard. Snapshots pin the
installation (including its context path), project ID, project key and issue type.
Retry reconciliation scans project issues, including closed issues, for the durable
write marker. Ticket creation defaults to disabled; enabling it requires the ticket
process to be loaded. `LocalJiraAdapter` is available from the `/testing` export for
persistent local scenarios.

## Profiles and delivery

`@leitwerk-dev/jira` is an opt-in Jira Data Center REST v2 integration. It supports
paginated discovery and issue/comment reads, including installations below a URL
context path. Load it with `jira-gitlab-change` to launch coordinated GitLab changes.

```yaml
extensions:
  jira:
    profiles:
      team:
        base_url: https://jira.example.org/jira
        token: env:JIRA_PAT
        # Optional project ID or key for Settings discovery, in addition to watcher projects:
        project: CLD
        # Optional when Epic Link schema discovery is ambiguous:
        epic_link_field: customfield_10014
```

Use a server-side personal access token that can read the selected projects and
write issue labels, remote links and workflow transitions. Comment writes are needed
only by consumers that post comments. Credentials never enter launch snapshots, worker
payloads, URLs, or diagnostic response bodies. Redirects are rejected.

Settings refresh discovers only projects selected by Jira watchers or the profile's
optional `project`, and their components, by installation URL and immutable ID.
The picker also excludes previously discovered components outside those configured
projects. Their retained settings still resolve through direct links.
Renaming a project or component preserves its settings. Discovery is explicit;
executing a process uses its retained bindings.

The issue watcher requires explicit project IDs and defaults to 30-second polling.
Only issues with the configured watcher `label` (default `use-leitwerk`), without `leitwerk-done`, and outside the Done status
category qualify. Installation URL (including context path) and immutable issue ID
form the launch deduplication key. Skip labels never launch a process by themselves.
The consuming process rechecks source eligibility and component mappings at admission.

`jiraIssuePolicy` observes plan-bypass and cancellation labels with subscription
and plan-revision correlation. An unavailable read retains the current policy and
reports a refresh error. All issue comments and label updates use durable external
writes. Comments carry reconciliation markers; retries after a lost response find
the existing comment. Label updates preserve unrelated labels.

`jira_ensure_remote_link` creates native Jira links to the current Leitwerk process
or its pinned merge request. MR link titles use the repository name and MR number.
Process URLs use `server.base_url`; stable global IDs
reconcile links after lost responses and restarts. `jira_transition_source_issue`
discovers an available transition by destination status name for In Progress or
In Review. Missing or ambiguous transitions and permission failures fail the owning
turn for generic retry. Replays preserve subsequent human status edits, and planning
never moves In Review back to In Progress or reopens Done tickets.

Issue splitting additionally needs issue creation and create-metadata access.
`jira-issue-split` supplies its own labeled-issue watcher and reviewed creation workflow.
Split ticket descriptions use Jira Server/Data Center wiki markup, with readable links.
The Jira extension also provides shared Markdown rendering and ticket-text checks
for splitters; reconciliation labels and durable receipts remain independent of
description text.
Epic membership uses the configured or schema-discovered Data Center Epic Link field.
Without that field, ordinary Jira changes remain available without epic wiki membership;
epic splitting requires the field. Other issues create subtasks using Jira's native
parent field and do not need Epic Link discovery. Subtask types are identified by
their metadata flag and ID, not by their display name.
Ambiguous Epic Link discovery requires an explicit override.
The [`@leitwerk-dev/wiki` package](../../packages/wiki/README.md) owns wiki tools,
storage, and browser views. Processes register `jiraWikiSource` as their source
resolver; it validates installation and immutable issue identity and refreshes the
shared requirement before wiki calls. It accepts retained `issueId` and legacy
`epicId` metadata. Jira does not register wiki tools.

A durable publication receipt or process binding can retain a wiki topic created by
another publisher. The topic key must identify the same Jira installation, including
its context path, and immutable source issue ID. The existing topic and page history
remain in place; a missing or mismatched topic fails without creating a replacement.
