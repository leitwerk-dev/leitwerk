---
name: open-pr
description: Publish a Leitwerk PR. Use when asked to commit and open a PR/MR, update an existing PR, or get a PR green.
---

# Publish a pull request

Leitwerk uses GitHub pull requests; “MR” means PR here. Publication ends with
verified hosted checks on the latest pushed head. Leave the PR unmerged; do not deploy.

## 1. Establish scope

Read [AGENTS.md](../../../AGENTS.md), [CONTRIBUTING.md](../../../CONTRIBUTING.md),
[WRITING.md](../../../WRITING.md), and the [CI requirements](../../../docs/maintainers/ci-and-releases.md).
Inspect the working tree, remotes, and current and default branches. Fetch the
target base and check divergence. Use a feature branch if on the default branch.
Preserve unrelated work. Query GitHub by head branch to find any existing PR.

## 2. Prepare review evidence

Review the complete base-to-head diff and intended uncommitted changes. Update
relevant docs and configuration examples. Run the required local checks, including
`npm run api:check` against built output for API changes. Reuse passing results
only when provenance is available and the validated inputs still match.

For UI changes, capture representative desktop and mobile views of the changed
interaction. Include before/after views when helpful and label fixture data.
Review each capture for settled content and fonts, readable controls, and absence
of credentials or private details. Embed reviewer-accessible hosted attachments;
keep screenshots out of Git and report any missing evidence. Revalidate after
application edits and replace screenshots that no longer match.

## 3. Commit and push

Stage only intended files, review the staged diff, and run `git diff --cached --check`.
Verify screenshots are absent from the PR history. Commit with `git commit -s` and
check each PR commit’s sign-off against its author, including inherited commits.
Push with an upstream. For an authorized rewrite, record the remote SHA first and
use `--force-with-lease=<ref>:<expected-sha>`. If the lease changes, inspect the
new commits before proceeding. Verify the remote head matches the publication SHA.

## 4. Create or update the PR

Use a Conventional Commit title and the repository template when present. Lead
with the user-visible problem and resulting behavior; include compatibility notes,
local validation results, and hosted UI examples. Keep local and hosted checks separate.
Update the existing PR if found; otherwise create it. Pass multiline text in a
file with `--body-file`. After ambiguous creation, query GitHub before retrying.

Read back the title, body, base/head branches, and `headRefOid`. Verify embedded
images are accessible and depict the published behavior.

## 5. Verify the published head

Run `gh pr checks <number> --watch --interval 30`. If watching times out, query
status and resume. On failure, inspect logs, fix within scope, validate, and push.
Rerun only with evidence of a transient failure. Any new push restarts this gate.

Query `gh pr view` and `gh pr checks` again. Both required checks must pass on the
current head; inspect any other failures. Missing, pending, cancelled, or skipped
required checks do not count as passing.

Close task-owned browser sessions and stop only servers started for this task.
Report the PR link, hosted CI status, missing evidence, and any remaining changes
or conflicts. If blocked, name the blocker and link the failing or outstanding check.
