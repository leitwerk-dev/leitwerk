# Jira Data Center

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
