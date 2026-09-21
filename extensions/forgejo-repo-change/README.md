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

By default the selected Forgejo profile also names the Woodpecker and Git SSH
profiles. Override this wiring in non-secret workflow configuration:

```yaml
extensions:
  forgejo-repo-change:
    profile_bindings:
      forgejo-team:
        woodpecker_profile: ci-team
        ssh_credential_ref: repository-writer
```

Omitted entries and fields use the Forgejo profile name. Present fields must be
nonempty strings; malformed mappings fail startup. Both launch paths validate all
three profiles. Launcher input cannot override CI, SSH, or runtime selection.
New projects record typed `forgejo` and `woodpecker` metadata plus the pinned Git
identity. Stored parameters retain their resolved profiles after configuration
changes; mappings affect future launches.

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
to 30 seconds. Only pipeline failures matching the current head trigger repair.
Push pipelines must also match the work branch; pull-request pipelines may report
the target branch. After three automatic CI cycles an operator must retry, resume
waiting, or abort. The budget is cumulative: publication, operator retry, and
resume waiting do not reset it. Success keeps delivery waiting for the PR outcome. Conflict evidence
permits one automatic repair per repository, PR, head, and base; publication uses
the original-head lease after completing and verifying the rebase.

Merge completes delivery. A source issue loses its trigger label, gains the done
label, receives a comment, and closes. Closing an unmerged PR aborts delivery and
leaves its source issue open after removing the trigger and commenting. Closing
the source issue or removing its trigger aborts waiting delivery directly.
UI-origin deliveries never require source issue access.

Feedback that needs no change receives a reply without a new commit. Feedback
that cannot be repaired waits for operator action with its evidence retained.
Repair publication updates the existing PR. Source cancellation leaves it open.

Restart resumes delivery from retained state. Consumed feedback and completed
external writes are not repeated. A merge that occurs while the server is
offline is reconciled when delivery resumes.

At operator action, **Retry repair** retains the pending evidence. **Resume waiting**
dismisses the pending feedback and adjustment, retaining accepted feedback cursors
and remote delivery state while waiting for new evidence.

## Composition and compatibility

The default extension and `forgejoRepoChangeProcess` require Docker at runtime.
For a composition without Docker, use:

```ts
import { createForgejoRepoChange } from "@leitwerk-dev/forgejo-repo-change";
const { extension, process } = createForgejoRepoChange({ docker: false });
```

Load exactly one variant per catalog. Each factory call owns a fresh process
and launcher configuration, cleared when its server stops. Both variants retain
the same process ID, turns, and state codec. The server controls runtime admission; repository content and launch parameters
cannot enable Docker. Credentials stay with their owning integrations.

Stored process IDs, turn IDs, state under `extensionState.forgejoRepoChange`,
subscriptions, project metadata, and external-write keys remain compatible with
existing deliveries. Legacy issue parameters without `origin` remain readable.
Forgejo and Woodpecker retain their documented persisted protocol identifiers.
The separate `remote-repo-change` extension continues direct base-branch delivery.
At operator action, **Retry repair** retains the pending evidence. **Resume waiting**
dismisses the pending feedback and adjustment, retaining accepted feedback cursors
and remote delivery state while waiting for new evidence.

## Integration tests

The composed workflow tests copy a pristine Git seed into an independent repository
per scenario and use in-memory SQLite. They retain real Git, HTTP actions and worker
IPC without repeating repository initialization. Failures report process and turn
state before cleanup. File-backed persistence is covered separately below.

## Restart verification

The provider sandbox's file-backed restart fixtures retain legacy issue/UI params,
Forgejo-only project metadata, completed write receipts and waiting subscriptions.
They reopen feedback, CI, conflict, operator and terminal deliveries, compare project,
turn and session identities, and verify that changed profile mappings do not rebind
existing work. A remote merge while the server is stopped completes after rearming.
Lost PR responses and publication retries reconcile one PR without duplicate comments.

## API support

The following exported declarations are `@public`:

- `@leitwerk-dev/forgejo-repo-change`: `ForgejoRepoChangeParams`, `createForgejoRepoChange`, `default`.

See the [SDK compatibility policy](../../docs/process-sdk.md#api-compatibility) for member classifications and support guarantees.
