# Coding

Shared repository-change planning, review, implementation, state, commit-message, and feature-branch publication support used by provider-owned processes and development compositions.

Owning extensions provide process identity, launcher policy, finalization copy, repository credential requirements, and a publication fragment. `@leitwerk-dev/forgejo-repo-change`, `@leitwerk-dev/github-repo-change`, and `@leitwerk-dev/gitlab-repo-change` are production consumers; the public sandbox supplies a local-only publication fragment for scripted scenarios.

Before first publication, `generate_commit_message` consumes the durable accepted
`plan` and latest `implementation-summary`. Preparation captures each repository's
HEAD, Git status, staged and unstaged diffs, and untracked filenames without changing
the checkout. Evidence is bounded to fit a preparation checkpoint and marks truncated
fields. The model can inspect relevant files with Pi's read-only `read`, `grep`,
`find`, and `ls` tools; it cannot run shell commands or modify files. Messages describe
the implemented change, using the plan for intent and the launch-pinned formatting
rules. The turn uses the `coding.implementation` model purpose and persists normalized
plain-text messages by project in `finalization.commitMessages`. Deliver then commits,
pushes, and publishes. Publication fragments also accept the legacy
`generatedCommitMessage` for resumed processes.

Each Git inspection command has a 60-second deadline by default. Configure
`coding.commit_message_git_timeout_ms` in Settings at the Instance or Repository
scope to override it without restarting. The value is a positive integer in
milliseconds, up to 2147483647. A new turn start or operator retry captures the
value; worker recovery retains it. Multi-repository processes use their primary
repository's value, or the Instance value when no primary repository is bound.
Historical starts without this setting use the 60-second default. A timeout fails
preparation and reports the repository, Git command, and configured deadline.

Inspection refreshes a temporary copy of each repository's index and reuses that
cache across commands. The checkout's index and staged changes remain intact.
Worker diagnostics record each command's duration and outcome, with bounded Git
Trace2 counters for metadata checks, content scans, and inspection phases. Raw
Trace2 events, file contents, and paths are not stored in these diagnostics.

`commitAndPushWorkBranch()` requires an explicit trusted Git identity, commits dirty workspace files, and pushes only the checked-out feature branch. Ordinary publication must retain the captured remote head as an ancestor. An exact-SHA lease also rejects concurrent rewinds; a successful push with a lost acknowledgement is recognized without another commit. Invalid identity, unresolved conflicts, branch mismatches and changed remote heads fail without discarding the local commit.

Turn labels use short task names: Plan, Review Plan, Implement, and Review. Automated assessments use Assess Plan and Assess Implementation so operators can distinguish them from their own decisions. Repository-change processes share these labels and turn ids.

## Planning contract

All consumers of the shared planner inspect relevant code, repository guidance,
dependency contracts, and external references before choosing the implementation.
A successful plan resolves questions affecting correctness, compatibility, and
feasibility, including access to required evidence. Material operator decisions
use `ask_questions` after discoverable facts are exhausted when the owning process
enables questions. When disabled, the planner decides from the requirement and
evidence, records minimal assumptions, and keeps the requested scope. Inaccessible
required evidence uses `abort_turn` with the resource, observed failure, and access needed;
the turn remains in error without publishing a successful plan or advancing.

Plans use **Findings and decisions**, **Changes**, and **Validation**, targeting
150–300 words for straightforward tickets and adding detail as complexity requires.
They record established decisions, concrete edits, and grouped validation checks.
`plan_saved` saves the finished plan with a one-sentence `summary` and
`acceptanceCriteria` limited to the requested outcomes. Approval and recovery use
the existing process flow.

## Shared publication

`createRepositoryChangePublication()` builds shared delivery, feedback, CI/rebase
repair, and operator turns for Forgejo, GitHub, and GitLab. Adapters supply provider
operations, evidence sources, repair tools/prompts, and pinned identities.
`sourceCancelled`, `reconcileAll`, and `reconcileTerminal` receive
`PublicationReconciliationContext`: process, projects, params, state, and integration
calls, without worker filesystem access. Cursors and receipts remain namespaced;
Forgejo retains its namespace, turn/action IDs, and write identities.

## Source-branch reconciliation

The remote source branch is authoritative. Implementation preparation captures the
local baseline before editing. Feedback and CI preparation fetch the current source
branch; delivery fetches again before publication. Observed revisions and historical
publication receipts are separate from the baseline for unpublished local work.
A developer push or rewritten history does not disable feedback handling.

Reconciliation replays only the local work since that baseline onto the current
remote revision. Previously published commits removed by a developer rewrite are
not restored. Unpublished commits, staged and unstaged edits, and non-ignored
untracked files survive synchronization. Dirty submodules, ignored-file collisions,
missing published branches, unrelated Git operations and unprovable baselines stop
with an explicit error rather than guessing or discarding files. Fetch and push must
use the same single origin endpoint. Previously ignored files are protected from
accidental publication if ignore rules change.

Before changing the checkout, private Git refs retain the original HEAD and separate
index/worktree checkpoint commits. A journal records the operation and its remote
revision. Git's rebase state and the journal survive worker replacement. After a
clean reconciliation, checkpoint commits are removed from the work branch and the
staged/unstaged distinction is restored. Replayed commits preserve original authors
and sign-offs, with the captured trusted project identity as committer. New integration
commits use that identity too; checkpoint identities never enter the published branch.
Recovery refs are retained; they are never included in feature-branch publication. Only the accepted worker may edit the
workspace. Deterministic reconciliation additionally takes a repository-local lock;
a lock from another host is not stolen automatically.

Conflicts use the existing adjustment turn. Its prompt permits rebase continuation
but prohibits skipping or removing checkpoint commits, resetting, aborting or
pushing. Delivery restores the normal checkout after resolution, then requests
validation of the combined result before publishing. A source change after validation
starts another reconciliation/validation pass; more than three automatic passes
require operator action. Explicit retry grants a new budget. No synchronization turns
are added to the process graph.

Publication records local write-ahead intent before sending a push and acceptance
before checking for subsequent remote movement. This receipt survives a lost server
acknowledgement: a later developer rewrite does not turn already-published work back
into an unpublished delta. Remote equality or ancestry can prove uncertain acceptance.
An explicit Git ref rejection proves no write; an unprovable transport outcome stops
for operator reconciliation rather than retrying over a possible developer rewind.
Missing branches with accepted or uncertain publication are never recreated
automatically. Receipts are recovery evidence on workspace storage; the server remains
the owner of durable process state.

Maintained processes route even `no_changes` through Deliver. It checks the remote
lease and publishes any retained unpublished work before acknowledging feedback.
An unchanged checkout creates no commit or push. A watcher may observe an active
worker's new remote head, but never mutates its checkout or captured baseline.

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
and recognizes an already-published result after a lost response. When its source
lease changes, shared delivery retains the completed repair and reconciles its net
change relative to the original source snapshot onto the latest remote branch.
Developer deletions and the agent's conflict resolutions both survive. The combined
result retains target-branch ancestry and requires validation before ordinary
leased fast-forward publication; delivery never substitutes a new lease into the
old force push. Retained state and refs are not deleted on success or failure.

## API support

The following exported declarations are `@public`:

- `@leitwerk-dev/coding`: `codingActionIds`, `createRepositoryChangeProcess`, `default`.
- `@leitwerk-dev/coding/auto-work-branch`: `buildAutoWorkBranchFromSeed`.
- `@leitwerk-dev/coding/finalization-git`: `GitIdentity`, `commitAndPushWorkBranch`.
- `@leitwerk-dev/coding/repository-change-launch`: `NormalizedRepositoryChangeParamsInput`, `RepositoryChangeLaunchParams`, `RepositoryChangeParamsBase`, `RepositoryIssueOriginParams`, `RepositoryUiOriginParams`, `createRepositoryChangeParamsCodec`, `normalizeRepositoryChangeParamsInput`, `repositoryChangeParamsRecord`.
- `@leitwerk-dev/coding/repository-change-publication`: `DeliveryState`, `PublicationContext`, `PublicationReconciliationContext`, `PublicationEvidence`, `PublicationFeedbackId`, `PublicationParams`, `PublicationPipeline`, `PublicationRequest`, `PublicationSource`, `PublicationState`, `RepositoryChangePublicationAdapter`, `applyPublicationEvidence`, `createRepositoryChangePublication`, `patchPublicationState`, `publicationObject`, `readPublicationState`.
- `@leitwerk-dev/coding/repository-rebase`: `ConflictEvidence`, `conflictEvidence`, `validateConflict`, `describeConflict`, `conflictKey`, `createConflictReporter`.
- `@leitwerk-dev/coding/repository-change-state`: `RepositoryChangeState`.

See the [SDK compatibility policy](../../docs/process-sdk.md#api-compatibility) for member classifications and support guarantees.

Pre-launch repository lookup uses `sanitizeWorkerSubprocessEnv` without project credentials. Trusted project Git operations use `repositoryGitSubprocessEnv(projectKey)`.

## Scoped settings

`coding.commit_message_git_timeout_ms` inherits Instance → Repository and is
captured with the implementation purpose for commit-message preparation.

Coding declares `coding.planning_model`, `coding.implementation_model`,
and `coding.review_model`. They inherit
Instance → Repository. Model null delegates to YAML and the allowed catalog;
explicit process/action choices take precedence.

Plan uses `coding.planning`; implementation, commit-message generation, feedback
revisions, CI repairs, and rebase repairs use `coding.implementation`;
simplification analysis uses `coding.review`. Each new step captures current values. Prepared starts and
worker recovery retain their snapshots. Model defaults use the primary repository.

## Streamlined coordinated changes

GitLab, GitHub, Forgejo, and Jira GitLab share six planning/implementation turns
plus four publication/repair turns. Plan decisions support approval and human-comment
revisions; implementation proceeds automatically to simplification and publication.
The optional `workflow` supplies server policies; `variant`, `finalizeLabel`, and
`finalizeForm` are deprecated and no longer select gates.
Server-side policies decide plan bypass and simplification routing. Decisions are
persisted with the plan revision or implementation boundary before routing.
The Workflow graph names these branches **Approval required**, **Skip plan
approval**, **Simplification enabled**, and **Skip simplification**. Route details
explain the policy and its launcher or source-label inputs. Applying simplification
rejoins commit-message generation as ordinary forward work.

Implementation starts at the session root with the accepted plan, not a prior review branch.
Simplification has a separate application turn consuming findings and plan. Multi-repository
sessions use the workspace root and persist commit messages by project key.
Before upgrading, finish or abort instances parked on removed plan-review,
implementation-review, implementation-approval, or simplification-approval turns.
Retain their history; existing delivery turns and state remain supported.

Publication adapters can coordinate repository-specific state and report aggregate
terminal outcomes while reusing the same publication, feedback, CI, and rebase logic.
GitLab, GitHub, and Forgejo adapters use `unchanged` to complete without publication,
removing the source trigger without closing the issue.
