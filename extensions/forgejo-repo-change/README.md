# Forgejo repository change

`@leitwerk-dev/forgejo-repo-change` plans, implements, and delivers repository
changes through a Forgejo pull request. It is opt-in and requires the `forgejo`,
`woodpecker`, `coding`, and `git-ssh` extensions. Enable `ticket-creation` when the
Forgejo integration's ticket feature is enabled.

## Configuration and launching

Configure server-owned profiles in the Forgejo, Woodpecker, and Git SSH extensions.
The UI launcher lists repositories visible to the selected Forgejo profile and
checks repository visibility, SSH read access, and dry-run SSH write access before
launching. The `use_leitwerk` watcher launches labeled source issues through the
same admission checks. Configure its profile, trigger/done labels, repositories,
and polling interval under `process_configs.forgejo_repo_change_process.watchers`.
See the [Forgejo integration](../forgejo/README.md) for provider configuration.

The UI starts without a source issue. Each replay generates a new work branch.
Issue launches retain their external issue identity and `leitwerk/issue-N` branch.
Plans and implementations require operator approval. Optional review,
simplification, and imported-plan routes share the coding process contracts.

## Delivery and recovery

The automatic `deliver_change` turn commits with the server-pinned Forgejo Git
identity, pushes a feature branch, and creates or reconciles one pull request.
It records delivery progress, feedback acknowledgements/replies, and provider
write receipts. External writes are durable and safe to retry.

Delivery waits for Forgejo feedback and terminal events and Woodpecker results.
Feedback settles for two minutes before revision in a fresh turn; polling defaults
to 30 seconds. Only pipeline failures matching the current branch and head trigger
repair. After three automatic CI cycles an operator must retry, resume waiting,
or abort. Success keeps delivery waiting for the PR outcome. Conflict evidence
permits one automatic repair per repository, PR, head, and base; publication uses
the original-head lease after completing and verifying the rebase.

Merge completes delivery. A source issue loses its trigger label, gains the done
label, receives a comment, and closes. Closing an unmerged PR aborts delivery and
leaves its source issue open after removing the trigger and commenting. Closing
the source issue or removing its trigger aborts waiting delivery directly.
UI-origin deliveries never require source issue access.

## Composition and compatibility

The default extension and `forgejoRepoChangeProcess` require Docker at runtime.
The server controls runtime admission; repository content and launch parameters
cannot enable Docker. Credentials stay with their owning integrations.

Stored process IDs, turn IDs, state under `extensionState.forgejoRepoChange`,
subscriptions, project metadata, and external-write keys remain compatible with
existing deliveries. Legacy issue parameters without `origin` remain readable.
Forgejo and Woodpecker retain their documented persisted protocol identifiers.
The separate `remote-repo-change` extension continues direct base-branch delivery.
