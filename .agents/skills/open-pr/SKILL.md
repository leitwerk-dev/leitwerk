---
name: open-pr
description: Publish a Leitwerk PR. Use when asked to commit and open a PR/MR, update an existing PR, or get a PR green.
---

# Publish a pull request

Leitwerk uses GitHub pull requests; “MR” means PR here. Publication ends with
verified hosted checks on the latest pushed head, not merely a successful push.
The request authorizes committing, pushing, and creating/updating the PR, but not
merging or deployment.

## 1. Establish the publication scope

Read [AGENTS.md](../../../AGENTS.md), [CONTRIBUTING.md](../../../CONTRIBUTING.md),
[WRITING.md](../../../WRITING.md), and
[CI requirements](../../../docs/maintainers/ci-and-releases.md).
These files own contribution and validation policy.

Inspect the working tree, current branch, remotes, default branch, and existing
PR. Fetch the target base and inspect divergence. Use a feature branch when on
the default branch; preserve unrelated work. Query GitHub explicitly for the head
branch so a resumed session updates its existing PR.

**Done:** repository, base/head, intended changes, unrelated work, and existing PR
(or confirmed absence) are identified.

## 2. Prepare review evidence

Review the complete base-to-head diff plus intended uncommitted changes. Align
required documentation and configuration examples with the implemented behavior.
Complete the validation required by repository policy. For application/API work,
run `npm run api:check` against built output as well as the applicable full gate.
Reuse a prior passing run only when its provenance is available and its validated
inputs still match; a prior session's success claim alone is insufficient.

For UI changes, capture representative desktop and mobile views, including the
interaction states that explain the change. Include before/after images when they
clarify a visual fix, and label fixture data as an example. Open each capture and
check that content and fonts have settled, controls are readable, and no
credentials or private details are visible. Keep screenshots out of Git; use
reviewer-accessible hosted attachments and embed them in the PR body. If capture
or hosting is blocked, report which evidence is missing.

Any subsequent application edit reopens the applicable validation gate and may
invalidate screenshots. Record blockers explicitly rather than claiming evidence
exists.

**Done:** every intended change is reviewed; required local checks pass for the
current inputs; UI evidence is reviewed and hosted, or its blocker is recorded.

## 3. Commit and push

Review the staged diff, run `git diff --cached --check`, and stage only intended
files. Verify PR screenshots are absent from both the staged changes and PR
history. Commit with `git commit -s`. Inspect every commit in the PR range for a
DCO trailer matching its author, including commits inherited from earlier work.
Repair sign-offs using an identity entitled to certify the contribution.

Push with an upstream. For an authorized history rewrite, record the remote head
first and use an explicit `--force-with-lease=<ref>:<expected-sha>`; a changed lease
requires inspecting the new remote commits before proceeding.

**Done:** intended commits are signed off, and the remote head equals the local
publication SHA.

## 4. Create or update the PR

Use a Conventional Commit title and the repository template when present. Lead
with the user-visible problem and resulting behavior; include relevant
compatibility notes, precise local validation results, and hosted UI examples.
Keep local validation separate from hosted CI status.

Write multiline text to a temporary file and pass `--body-file` to `gh pr create`
or `gh pr edit`. Update the existing PR instead of duplicating it. After an
ambiguous creation failure, query GitHub before retrying.

Read back the title, body, base/head branches, and `headRefOid`. Verify embedded
image URLs are accessible to reviewers and depict the published behavior.

**Done:** one PR targets the intended base and publication SHA, with the intended
body and no stale evidence links.

## 5. Get the published head green

Watch hosted CI with `gh pr checks <number> --watch --interval 30`. On timeout,
query status and resume watching; timeout is not a failed check. On failure,
inspect the failing job logs, fix the cause within scope, validate, and push.
Rerun only when evidence supports a transient failure. Any new push or rewrite
restarts this gate for the new SHA.

Finally query `gh pr view` and `gh pr checks` again. Require both `Full validation`
and `Conventional PR title and DCO` to pass on the current head; inspect any other
failed checks. Missing, pending, cancelled, or skipped required checks do not
establish a green PR. If credentials, infrastructure, or an out-of-scope failure
blocks completion, report the exact blocker and check URL.

Close task-owned browser sessions and stop only servers started for this task.
Finish with the PR link, hosted CI status, and any missing evidence. Mention
remaining working-tree changes or merge conflicts when relevant. Leave the PR
unmerged.

**Done:** the current remote head is verified green, or the PR is explicitly
reported as blocked with outstanding checks/evidence named.
