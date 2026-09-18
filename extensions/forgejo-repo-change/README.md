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

## CI routing verification

CI routing uses the process definition as its pure test interface; no additional
policy facade is needed. `src/ci-routing.test.ts` invokes the production guards,
effects, outcomes, and operator actions without starting a server or worker.

The former sandbox test “CI ignores stale branch/head and success, repairs three
times, then allows operator recovery” has these replacements:

| Failure mode | Replacement |
| --- | --- |
| Missing retained counter, cycles 0–2, exhausted cycles 3+ | `ci-routing.test.ts`: exclusive repair/operator guards, evidence retention, counter increment, state immutability |
| Repair completion accidentally resets the budget | `ci-routing.test.ts`: changes-ready and no-changes outcomes retain the counter |
| Operator retry loses evidence or chooses the wrong repair turn | `ci-routing.test.ts`: CI, feedback, and rebase retry routing |
| Resume resets the budget or loses accepted cursors | `ci-routing.test.ts`: resume clears only pending feedback/adjustment |
| Operator abort starts another repair | `ci-routing.test.ts`: terminal abort route |
| Unrelated branch/SHA or successful CI starts work | `remote-change.integration.test.ts`: explicit provider polls leave delivery waiting without a repair turn |
| Provider failure or worker outcome fails to reach durable routing | `remote-change.integration.test.ts`: exact-SHA failure, worker escalation, HTTP operator retry, and retained cycle count |
| Repair publication creates another PR | `remote-change.integration.test.ts`: real Git head advances while one PR is retained |

The integration fixture composes production extensions directly with local
Forgejo/Woodpecker adapters, file-backed SQLite, real Git, and in-process scripted
workers. It does not use sandbox scenarios or control endpoints. The automatic
cycle limit is tested as data rather than by executing three repository repairs.
These tests do not claim subprocess or crash-recovery coverage; the restart
scenarios below remain separate.

## Feedback routing verification

`src/feedback-routing.test.ts` covers feedback evidence reduction and the
`changes_ready`, `no_changes`, and `cannot_repair` routes through the production
process definition. It checks cursor retention, state immutability, and whether
publication is requested. Operator retry and resume policy remain covered by
`src/ci-routing.test.ts`.

The remaining two scenarios from `tests/e2e/sandbox/forgejo-routing.e2e.test.ts`
are replaced by `src/feedback-routing.integration.test.ts`; the E2E file is removed.

| Former scenario | Replacement guarantees |
| --- | --- |
| Feedback needs no change | Provider feedback reaches a scripted worker; `no_changes` replies to the original feedback once, clears the pending adjustment, and retains the Git head and history |
| Feedback requires an operator | Worker `cannot_repair` reaches the persisted operator turn with its evidence; HTTP resume clears pending feedback without publishing or replying |
| Both paths | Delivery rearms, accepted cursors survive, one PR remains, and polling consumed feedback causes no second revision or reply |

These integration tests use the extension-owned fixture, not sandbox controls.
An explicit clock advance settles feedback and passes the polling throttle without
sleeping. Quiet-period edge cases remain the provider tests' responsibility. The
fixture uses real Git and file-backed SQLite. Feedback is delivered after restart;
operator escalation is reopened before resume. Another restart verifies that
consumed feedback does not produce a second revision or reply. These expanded
restart cases have a 30-second per-case budget.

## Terminal reconciliation verification

Four PR-close/source-cancellation cases formerly in
`tests/e2e/sandbox/forgejo-reconciliation.e2e.test.ts` are replaced as follows:

| Former case / failure mode | Replacement |
| --- | --- |
| Closing a UI PR does not access an issue or relaunch after restart | Existing UI terminal case in `src/remote-change.integration.test.ts`, extended with restart, retained write receipts, and empty subscriptions |
| Closing an issue-origin PR removes its trigger and comments, but leaves the issue open | `src/terminal-reconciliation.integration.test.ts`: exact link/closure comments, open issue, removed label, and no duplicate process or writes after restart |
| Closing the source issue or removing its trigger is detected | `extensions/forgejo/src/provider.test.ts`: both cancellation reasons and a non-cancelled control case |
| Source cancellation aborts without another worker turn | `src/terminal-reconciliation.integration.test.ts`: a real provider poll delivers trigger removal; worker records, write receipts, and comments remain unchanged |
| Cancellation cannot apply to UI origins; PR closure must reconcile before aborting | `src/terminal-routing.test.ts`: production guards, terminal routes, and retained PR evidence for both origins |

The integration cases use file-backed SQLite, real Git, production provider
registration and scripted in-process workers. Source cancellation leaves the PR
open; it does not perform PR-closure reconciliation. The provider tests own the
cancellation-reason matrix, so both reasons do not require complete workflows.

## Publication and repair E2E replacement ledger

`src/publication-repair.integration.test.ts` replaces four cases from the sandbox
workflow/reconciliation E2Es. Each replacement must pass before its predecessor is
removed. The fixture composes production extensions directly: real HTTP launch,
SQLite, Git clones/push/rebase, provider polling, and worker runtime over WebSocket.
Pi and provider services are local scripted adapters; Docker preflight and process
spawn are substituted. Restarts reopen disk state in a fresh app, catalog, adapters,
and Pi factory. These tests do not claim physical-worker or abrupt-crash coverage.

| Former E2E / assertion | Owning replacement |
| --- | --- |
| UI launcher publishes with Forgejo/Woodpecker project metadata | UI publication test checks retained profiles, actual remote file content, and `forgejo.ensure_pr` receipt |
| Session reasoning retains launch prompt and nonempty thinking | UI publication test reads the planning record through reasoning HTTP |
| Merge completes without creating an issue; replay uses a new branch | UI publication test completes via provider polling, checks zero issues, then relaunches the same prompt and checks new process/branch identities |
| Sandbox diff endpoint shows the published change | Retained issue-discovery E2E checks the diff endpoint; extension test independently checks real remote Git content |
| Conversation, inline, and review feedback batch and publish a fresh revision | Feedback test checks changed Git head/content, exactly one distinct revision with null fork, two reactions, and three replies correlated to the feedback IDs |
| Restart/poll duplicates neither replies nor PRs | Feedback test reopens SQLite/adapters, polls consumed feedback, and compares replies, reactions and turn records while retaining one PR |
| CI diagnosis explicitly restarts through a durable write without changing head | CI test checks log-read-before-restart ordering, one restart call/receipt, pending pipeline and unchanged published head |
| CI restart replay survives application restart | CI test reopens storage, polls the retained pipeline, and checks one pipeline, unchanged receipts, no further restart calls and unchanged head |
| Conflict after restart rebases and publishes with the retained lease | Conflict test creates an actual conflicting base commit after fresh-app rearming; production Git starts the rebase, scripted Pi resolves it and continues Git; assertions check base ancestry/content, original-head/branch in the rebase record, stable project branch and updated remote head |
| Conflict publication remains stable on poll and can merge | Conflict test polls again without head/PR duplication, then merges and completes |

The retained public E2Es are local repository finalization, issue discovery through
merge/issue completion, and lost-PR-response recovery/replay. Sandbox control
idempotency remains separate from extension publication policy.

## Integration tests

The composed workflow tests copy a pristine Git seed into an independent repository
per scenario and use in-memory SQLite. They retain real Git, HTTP actions and worker
IPC without repeating repository initialization. Failures report process and turn
state before cleanup. File-backed persistence is covered separately below.

## Restart verification

`src/persistence-recovery.integration.test.ts` replaces the repeated restart-to-merge
workflows in `tests/e2e/sandbox/forgejo-resume.e2e.test.ts`. It has two cases:

1. Reopen armed UI delivery with Forgejo-only project metadata, then diagnose and
   publish a CI repair through the retained provider profiles.
2. Reopen legacy issue delivery, merge its PR while the server is offline, and
   reconcile completion once after rearming. Restart again to check write replay.

Both cases compare persisted process state, project identity and metadata, turn
records, write receipts, subscription identities/configuration, and nonempty saved
Pi reasoning. Changed profile mappings affect future launches, not retained work.
The fixture constructs a fresh app, catalog, provider adapters, and scripted Pi
factory on restart; only disk state is authoritative. These are graceful shutdown
and offline-event tests, not abrupt subprocess-death tests.

| Former resume case / failure mode | Replacement |
| --- | --- |
| Feedback after rearming; no duplicate reply after another restart | `feedback-routing.integration.test.ts`: delivery restart before feedback, then persisted cursor/reply replay |
| CI after rearming with legacy metadata and changed configuration | `persistence-recovery.integration.test.ts`: UI delivery case, including real Git publication and Woodpecker tool calls |
| Conflict after rearming and retained original-head lease | `publication-repair.integration.test.ts`: fresh app before a real conflicting base commit, preserved base content, original-head lease and subsequent merge |
| Operator state survives restart without arming delivery sources | `feedback-routing.integration.test.ts`: retained evidence, turns and writes before HTTP resume; CI/feedback/rebase retry selection remains in `ci-routing.test.ts` |
| Terminal event occurs offline; issue finalization is not duplicated | `persistence-recovery.integration.test.ts`: legacy issue case |
| Legacy issue parameters normalize before selecting sources | `params.test.ts` and `delivery-sources.test.ts` |
| Source selection retains profiles, head, cursors, pipeline floor and conflict key | `delivery-sources.test.ts`: production source resolvers and guards, including the exhausted CI budget and no sources on repair/operator turns |
| Forgejo-only metadata resolves the retained CI profile, not the Forgejo profile | `extensions/woodpecker/src/binding.test.ts`: legacy/dedicated binding matrix and invalid dedicated metadata rejection |

No new policy facade is needed: the parameter codec, source resolvers, and existing
project-binding resolver are already direct test interfaces. Lost PR responses and
publication retries remain covered separately in the reconciliation E2E.
