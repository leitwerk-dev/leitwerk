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
        # Optional when Epic Link schema discovery is ambiguous:
        epic_link_field: customfield_10014
```

Use a server-side personal access token that can read the selected projects and
write issue comments and labels. Credentials never enter launch snapshots, worker
payloads, URLs, or diagnostic response bodies. Redirects are rejected.

Settings refresh discovers projects and components by installation URL and immutable
ID. Renaming a project or component preserves its settings. Discovery is explicit;
executing a process uses its retained bindings.

The issue watcher requires explicit project IDs and defaults to 30-second polling.
Only issues with `use-leitwerk`, without `leitwerk-done`, and outside the Done status
category qualify. Installation URL (including context path) and immutable issue ID
form the launch deduplication key. Skip labels never launch a process by themselves.
The consuming process rechecks source eligibility and component mappings at admission.

`jiraIssuePolicy` observes plan-bypass and cancellation labels with subscription
and plan-revision correlation. An unavailable read retains the current policy and
reports a refresh error. All issue comments and label updates use durable external
writes. Comments carry reconciliation markers; retries after a lost response find
the existing comment. Label updates preserve unrelated labels. No Jira status
transition is performed.

Issue splitting additionally needs issue creation and create-metadata access.
`jira-epic-split` supplies its own labeled-issue watcher and reviewed creation workflow.
Epic membership uses the configured or schema-discovered Data Center Epic Link field.
Without that field, ordinary Jira changes remain available without epic wiki membership;
epic splitting requires the field. Other issues create subtasks using Jira's native
parent field and do not need Epic Link discovery. Subtask types are identified by
their metadata flag and ID, not by their display name.
Ambiguous Epic Link discovery requires an explicit override.
Topic-bound `wiki_index`, `wiki_read`, and `wiki_share` tools provide evidence-backed
sharing; each call refreshes the source issue and derives provenance from its accepted
process turn, not model-supplied identities. See [topic wikis](../../docs/topic-wiki.md).
