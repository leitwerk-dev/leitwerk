---
name: open-mr
description: Open or update a Leitwerk pull request from completed changes, including validation, DCO sign-offs, and example images for UI changes. Use when asked to commit, push, and open an MR or PR in this repository.
---

# Open a merge request

Leitwerk uses GitHub pull requests. Treat an MR request as a PR request here.

Read [AGENTS.md](../../../AGENTS.md), [CONTRIBUTING.md](../../../CONTRIBUTING.md),
[WRITING.md](../../../WRITING.md), and [CI requirements](../../../docs/ci.md) before
preparing the contribution. These files own the repository policy.

## Prepare the changes

- Inspect the working tree, remote, base branch, and existing PR for the branch.
  Include the requested changes and their documentation; preserve unrelated work.
- Use a feature branch when the checkout is on the default branch. Fetch the base
  before choosing it, and inspect any divergence before publishing.
- Complete the validation required by AGENTS.md. Application changes require a
  successful `npm run test:full`; scoped exceptions follow the repository policy.
  Run `npm run api:check` against the built output for API changes. Existing passing
  validation can be reused when the application and test sources have not changed.
- Review the final diff and use a Conventional Commit title for the PR. Commit
  with `git commit -s`; every commit's DCO trailer must match its author identity.

## Include UI examples

UI changes require example images embedded in the PR description. Capture the
implemented interface at desktop and mobile widths with representative content.
Include before/after images when they clarify a visual fix. Label fixture data as
an example rather than an operator's installation.

Open each capture before publishing. It must show settled fonts and content,
readable controls, and the changed area. Inspect screenshots for credentials,
private repository details, or other unintended content. Local file links and
temporary test artifact paths are insufficient for a hosted PR.

Use supported platform attachments when available. Otherwise, commit the reviewed
images under `docs/images/<feature>-desktop.png` and
`docs/images/<feature>-mobile.png`, and embed URLs pinned to the pushed commit:

```markdown
![Desktop example](https://raw.githubusercontent.com/OWNER/REPO/COMMIT/docs/images/FEATURE-desktop.png)
<img src="https://raw.githubusercontent.com/OWNER/REPO/COMMIT/docs/images/FEATURE-mobile.png" alt="Mobile example" width="390">
```

Verify that both image URLs are accessible to reviewers. If capture or hosting is
blocked, complete the available work and report exactly which evidence is missing;
do not claim that images were attached.

## Publish the PR

Push the feature branch with its upstream. The user's request to commit, push, and
open a PR authorizes those actions; it does not authorize merging or deployment.

Write a description that leads with the user-visible problem and resulting
behavior, then adds relevant validation and the example images. Use the repository
template when present. With `gh`, write multiline text to a temporary file and use
`--body-file`. Update an existing PR for the branch instead of creating a duplicate;
after an ambiguous failure, query GitHub before retrying a creation.

Read back the PR title, base/head branches, body, and checks. Distinguish local
validation from hosted CI. Before merge, both `Full validation` and
`Conventional PR title and DCO` must pass; pending CI does not prevent opening the
PR. Finish with the PR link, validation status, and any missing evidence.
