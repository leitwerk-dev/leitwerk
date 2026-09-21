
Shared integration APIs include typed repository feedback batches, repository
watcher/source parsing and presentation, argument/JSON validation,
`IntegrationHttpError`, `repositoryHttpsUrl`, and optional server logging.
`createExternalSourcePollReporter` returns `ExternalSourcePollReporter`; use
`isCurrent(kind, armed)` after provider I/O or supply `currentKinds` to guard
`fire` and `observe`. Generation forwarding is opt-in.

Use `sanitizeWorkerSubprocessEnv` for ordinary subprocesses and pre-launch lookup.
Use `repositoryGitSubprocessEnv(projectKey)` when trusted Git execution needs the
selected project's credentials. Overrides are filtered before credentials are
added by the trusted operation.
