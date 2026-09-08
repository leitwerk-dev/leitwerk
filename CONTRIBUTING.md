# Contributing to Leitwerk

Leitwerk is licensed under the Apache License, Version 2.0.

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in Leitwerk is submitted under the Apache License,
Version 2.0, without additional terms or conditions.

Do not submit code, documentation, media, or other material unless you
have the right to license it under Apache-2.0.

If something is not intended as a contribution, clearly mark it:
“Not a Contribution”.

## Developer Certificate of Origin

This project uses the Developer Certificate of Origin, version 1.1.

The DCO is a lightweight way for contributors to certify that they wrote
the contribution, or otherwise have the right to submit it under the
project license.

By signing off a commit, you certify the DCO for that commit.

The canonical DCO text is available at:

    https://developercertificate.org/

Every commit must contain a sign-off line in the commit message:

    Signed-off-by: Full Name <email@example.com>

The name and email address in the sign-off should identify the person who
is certifying the contribution. Use a real name or another identity that
you are entitled to use for this purpose.

You can add the sign-off automatically when committing from the command
line:

    git commit -s

For an existing commit, you can usually add a sign-off with:

    git commit --amend -s

For multiple existing commits, use an interactive rebase and add the
sign-off to each commit.

Pull requests without the required DCO sign-off may not be merged.

## Pull request titles and releases

Pull request titles use Conventional Commits syntax because GitHub uses the title for the squash commit:

    feat(process-sdk): add a builder
    fix(worker): reject a stale result
    feat(protocol)!: remove a frame
    docs: explain worker leases

`feat` and `fix` contribute release notes. Add `!` or a `BREAKING CHANGE:` footer for a breaking change. `docs`, `test`, `ci`, `build`, and `chore` do not request a release by themselves.

Merging an ordinary pull request never publishes. It updates the reviewable Release Please pull request. Maintainers publish by merging that generated pull request. See [docs/ci.md](docs/ci.md) for version rules and artifact coordinates.

## Reviewing a pull request stack

Use an authenticated GitHub CLI (`gh`) and pass the top PR to the status helper:

```bash
npm run review:stack -- https://github.com/leitwerk-dev/leitwerk/pull/37
npm run review:stack -- 37 --repo leitwerk-dev/leitwerk --checkout /path/to/review-clone
npm run --silent review:stack -- 37 --json
```

The report orders dependencies from the bottom PR to the supplied top PR, following
base/head branch relationships. It includes merged and closed PRs, rejects ambiguous
parents, and stops at the default branch or a base without a matching PR. It shows
checkout dirtiness, exact base/head SHAs, base commits missing from each head, GitHub
mergeability, hosted checks, and locally recorded full validation. Repeat `--checkout`
to include other clones; separate clones are not discovered automatically.

The report includes every unresolved review thread, including outdated threads, with
its first comment and latest reply. Put `<!-- stack-review:decision -->` in a thread's
first comment to mark it as a decision for `/code-review`. Marked decisions have a separate
count so informational review guides do not look like unanswered policy questions.
An answer does not close a thread: address the decision before resolving it on GitHub.
Unmarked threads remain visible; the helper does not infer decisions from their text or
from ordinary PR comments. JSON retains the complete first and latest comment text.

To record local validation for the current commit:

```bash
npm run review:stack -- validate
```

This runs `npm run test:full` in a clean checkout. `validate --checkout /path/to/clone`
selects another checkout. It records the command, exact SHA, time, Node version, platform,
and result below the Git directory at `stack-review/validations/<sha>.json`. A changed
HEAD or dirty checkout after the run invalidates the result. Interrupted runs remain
`running`, never `passed`. Each invocation runs the full gate; status reports let the
reviewer identify a previously validated SHA. Old logs are not imported automatically.
Local results describe committed code; checkout dirtiness is reported separately and
hosted checks remain independent. Status exits successfully when the report is collected,
even when checks fail or decisions remain; it is not a merge gate.

Status makes read-only GitHub requests. The helper does not commit, fetch, switch
branches, push, merge, rerun hosted checks, or publish comments.
