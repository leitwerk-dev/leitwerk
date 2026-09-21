# Repository rebase

The root export contains `ConflictEvidence`, `conflictEvidence`, `validateConflict`,
`describeConflict`, `conflictKey`, and `createConflictReporter`. Provider polling can
import it without loading Git execution or repair prompts. Evidence shapes and
deduplication keys remain stable across the package move.
`createConflictReporter(kind)` uses the supplied `ExternalSourcePollReporter` for
freshness checks; callers no longer pass a source service. Use
`report.isCurrent(kind, armed)` instead of the removed internal `sameSubscription`.
The conflict reporter observes refreshes and deduplicates accepted pairs per live subscription; its result indicates a fire attempt, including rejected attempts that remain retryable.

Import `prepareRebase`, `startRebase`, `verifyRebase`, `publishRebase` and
`RebaseInput` from `@leitwerk-dev/repository-rebase/git`. Import `rebasePrompt` from
`@leitwerk-dev/repository-rebase/prompt`. Owning processes decide when to prepare,
request human/model repair, validate the repository and publish.

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
