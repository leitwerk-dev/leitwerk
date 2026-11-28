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
[WRITING.md](../../../WRITING.md), and [CI requirements](../../../docs/maintainers/ci-and-releases.md).

Inspect the working tree, branch, remotes, and divergence from the fetched base.
Use a feature branch when on the default branch and preserve unrelated work.

## 2. Prepare review evidence

Review the complete base-to-head diff plus intended uncommitted changes. Align
required documentation and configuration examples with the implemented behavior.
Run the required local validation. Reuse a passing run only when its provenance
is available and the validated inputs still match. Revalidate after application edits.

For UI changes, capture representative desktop and mobile views, including the
interaction states that explain the change. Include before/after images when they
clarify a visual fix, and label fixture data as an example. Open each capture and
check that content and fonts have settled, controls are readable, and no
credentials or private details are visible. Keep screenshots out of Git; use
reviewer-accessible hosted attachments and embed them in the PR body. If capture
or hosting is blocked, report which evidence is missing. Refresh affected captures after edits.

## 3. Commit and push

Review the staged diff, run `git diff --cached --check`, and stage only intended
files. Verify PR screenshots are absent from both the staged changes and PR
history. Commit with `git commit -s` and check DCO compliance across the PR range,
including inherited commits. Repair sign-offs only with an identity entitled to
certify the contribution.

Push with an upstream and verify the remote SHA matches. For an authorized
history rewrite, record the remote head first and use an explicit
`--force-with-lease=<ref>:<expected-sha>`. If the lease changed, inspect the new
remote commits before proceeding.

## 4. Create or update the PR

Use a Conventional Commit title and the repository template when present. Lead
with the user-visible problem and resulting behavior; include relevant
compatibility notes, precise local validation results, and hosted UI examples.
Keep local validation separate from hosted CI status.

Query GitHub by head branch and update the existing PR if found. Pass multiline
text via `--body-file`. After an ambiguous creation failure, query before retrying.

Read back the title, body, base/head branches, and `headRefOid`. Verify embedded
image URLs are accessible to reviewers and depict the published behavior.

## 5. Get the published head green

Watch hosted CI with `gh pr checks <number> --watch --interval 30`. On timeout,
query status and resume watching; timeout is not a failed check. On failure,
inspect the failing job logs, fix the cause within scope, validate, and push.
Rerun only for evidenced transient failures. After any push or rewrite, restart
verification. Use `gh pr view` and `gh pr checks` to confirm both required checks
pass on the current head. Inspect other failures; report blockers with check URLs.

Close task-owned browser sessions and servers. Report the PR link, hosted CI
status, missing evidence, and any remaining conflicts or working-tree changes.
