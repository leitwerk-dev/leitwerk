# Coding

Shared repository-change planning, review, implementation, state, commit-message, and feature-branch publication support used by provider-owned processes and development compositions.

Owning extensions provide process identity, launcher policy, finalization copy, repository credential requirements, and a publication fragment. `@leitwerk-dev/forgejo-repo-change`, `@leitwerk-dev/github-repo-change`, and `@leitwerk-dev/gitlab-repo-change` are production consumers; the public sandbox supplies a local-only publication fragment for scripted scenarios.

After final implementation approval, `generate_commit_message` consumes the durable accepted `plan` without repository tools. It uses the model configured for `pi.process_title_generation.model_profile` (or the process's inherited model when title generation has no profile), applies the formatting rules pinned in project metadata at launch, and persists the normalized plain-text message in finalization state. Publication fragments consume that message.

`commitAndPushWorkBranch()` requires an explicit trusted Git identity, commits dirty workspace files, and pushes only the checked-out feature branch. It rejects invalid Git identity, unresolved conflicts, branch mismatches, and remote heads that do not match the committed HEAD.

Turn labels use short task names: Plan, Review Plan, Implement, and Review. Automated assessments use Assess Plan and Assess Implementation so operators can distinguish them from their own decisions. Repository-change processes share these labels and turn ids.

## Shared publication

`createRepositoryChangePublication()` constructs the delivery, feedback, CI repair,
rebase, and operator recovery fragment used by Forgejo, GitHub, and GitLab repository
change processes. Its adapter supplies provider operations, native evidence sources,
repair tools/prompts, pinned identity resolution, and stored names. The shared module
owns Git publication and lifecycle policy without importing provider integrations.
Provider cursors and receipts remain durable in namespaced publication state.
Forgejo retains its original namespace, turn/action identifiers, and write identities.

## Git rebase repair

Provider adapters import conflict evidence and reporting helpers from
`@leitwerk-dev/coding/repository-rebase`. This entry point does not load Git execution
or repair prompts. The shared publication flow owns rebase preparation, repair
prompts, verification, and publication internally.

Use a full checkout with an `origin` remote and a distinct tracked work/base
branch. Shallow clones and linked worktrees are not supported. Git must support
`merge-tree --write-tree` (Git 2.38 or newer), `rebase --rebase-merges`, retained
refs, `ls-remote`, and explicit `--force-with-lease=<ref>:<sha>` pushes. Git uses
the SDK's project-scoped subprocess environment and resolved Git binary. Configure
Git credentials for the project through its owning integration; do not pass
provider API credentials to this helper.

Preparation verifies branches, a clean worktree, the tracked remote head and base
ancestry. It records the original head and fetched base before changing HEAD.
`.git/leitwerk-rebase.json`, `refs/leitwerk/rebase-original`,
`refs/leitwerk/rebase-head`, `refs/leitwerk/rebase-base` and Git's rebase state survive
worker retries. New records also retain origin identity; existing records without
that optional field remain readable. Changing origin or rewriting the prepared
base is rejected. A compatible advancing base remains valid evidence for the
captured repair; subsequent provider evidence can request another repair.

A locally clean conflict report does not rewrite the branch. Behind-base reports
incorporate the fetched base even if merging is clean. Interrupted rebases resume
Git's existing state and preserve authors and sign-offs. Continuation verification
rejects unfinished/aborted rebases, wrong branches and dirty results. Publication
uses the original recorded head as an explicit lease, rejects concurrent pushes,
and recognizes an already-published result after a lost response. Retained state
and refs are not deleted on success or failure.

## API support

The following exported declarations are `@public`:

- `@leitwerk-dev/coding`: `codingActionIds`, `createRepositoryChangeProcess`, `default`.
- `@leitwerk-dev/coding/auto-work-branch`: `buildAutoWorkBranchFromSeed`.
- `@leitwerk-dev/coding/finalization-git`: `GitIdentity`, `commitAndPushWorkBranch`.
- `@leitwerk-dev/coding/repository-change-launch`: `NormalizedRepositoryChangeParamsInput`, `RepositoryChangeLaunchParams`, `RepositoryChangeParamsBase`, `createRepositoryChangeParamsCodec`, `normalizeRepositoryChangeParamsInput`, `repositoryChangeParamsRecord`.
- `@leitwerk-dev/coding/repository-change-publication`: `DeliveryState`, `PublicationContext`, `PublicationEvidence`, `PublicationFeedbackId`, `PublicationParams`, `PublicationPipeline`, `PublicationRequest`, `PublicationSource`, `PublicationState`, `RepositoryChangePublicationAdapter`, `applyPublicationEvidence`, `createRepositoryChangePublication`, `patchPublicationState`, `publicationObject`, `readPublicationState`.
- `@leitwerk-dev/coding/repository-rebase`: `ConflictEvidence`, `conflictEvidence`, `validateConflict`, `describeConflict`, `conflictKey`, `createConflictReporter`.
- `@leitwerk-dev/coding/repository-change-state`: `RepositoryChangeState`.

See the [SDK compatibility policy](../../docs/process-sdk.md#api-compatibility) for member classifications and support guarantees.

Pre-launch repository lookup uses `sanitizeWorkerSubprocessEnv` without project credentials. Trusted project Git operations use `repositoryGitSubprocessEnv(projectKey)`.

## Scoped settings

Coding declares `coding.planning_model`, `coding.implementation_model`,
`coding.review_model`, and `coding.repository_instructions`. They inherit
Instance → Repository. Model null delegates to YAML and the allowed catalog;
explicit process/action choices take precedence. Instructions append by default,
or replace inherited blocks when selected. Empty replacement clears them.

Plan uses `coding.planning`; implementation and commit-message generation use
`coding.implementation`; plan review, implementation review, and simplification
use `coding.review`. Each new step captures current values. Prepared starts and
worker recovery retain their snapshots. Multi-repository instruction blocks are
labelled separately; model defaults use the primary repository.
