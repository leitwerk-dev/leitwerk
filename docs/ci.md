# CI, dependency updates, and releases

Every merge to `main` that increments the version automatically publishes a stable release. Non-release changes do not publish artifacts.

Stable releases use one version, `X.Y.Z`, across all npm packages, container images, and the Helm deployment chart. CI creates tag `vX.Y.Z` and a draft GitHub Release, publishes npm packages under `latest`, attaches the chart and lock file, then publishes the draft.

## Validation

Every PR must pass `Full validation` and `Conventional PR title and DCO`. These checks cover builds, type checks, tests, PR title format, and commit sign-offs. Publication also validates release metadata and package contents.

Application validation and image validation run on separate runners in parallel.
`Full validation` succeeds only when both jobs succeed; failures, cancellations,
and skipped prerequisites fail the required result. Image validation solves both
Dockerfiles' `build` targets on one Buildx builder, without loading or pushing
images. Separate GHA layer caches retain intermediate layers and fall back to
`main` on new PRs.

CI and publication workflows run `npm run api:check` as a required step after
`npm run test:full`; the local full gate does not include it. It checks explicit
`@public`/`@internal` annotations and public signature dependencies. Both
classifications remain in published declarations.

Builds, tests, and browser installation use Node 26. Validation runs Chromium,
Firefox, and WebKit. See [Testing](testing.md) for local commands and scoped checks.
Browser tests reuse the production UI bundle from the full gate’s build phase.
CI also builds the documentation with strict link and anchor validation and caches
pip downloads by `requirements-docs.txt`. The site includes extension READMEs,
their process graphs, and the wiki package reference. Relative links resolve from
their repository locations; existing core documentation URLs stay unchanged.
New commits cancel obsolete PR validation runs; validation of `main` is not cancelled.

PR validation warns when combined test runtime is at least 5% above the average
of the last ten comparable successful `main` runs. Only test execution time counts,
including browser tests. The warning appears in Actions annotations and the job
summary; it does not fail validation. Comparison is skipped when timing data is
unavailable or fewer than ten comparable runs exist. Process E2E and jsdom UI
integration durations are recorded separately; historical comparisons combine
them to match older reports. Each validation attempt uploads detailed test logs,
Vitest suite/test reports, and per-engine browser-shard reports, including retries,
on success or failure. These diagnostic artifacts are retained for 14 days.

## Publication safeguards

Publication runs only from `main`, uses the main-only `npm-publish` environment without required reviewers, and authenticates with short-lived npm credentials. The exact versioned source must pass validation before publication.

Each release tag points to a reproducible, signed-off commit whose only parent is the originating main revision. The commit records that revision and the previous release tag. Conflicting tags, changed contents, skipped qualifying merges, and releases not owned by automation are rejected. Release commits do not update `main`. Use release tags for released package and chart versions and the cumulative changelog.

Stable images use application source from the verified release tag and Dockerfiles
from the main revision running publication. Build recipe fixes can therefore resume
a draft release without changing its tag. CI compiles both image build stages.

## Retries

Releases publish serially in main's first-parent order. Git history is the durable backlog, and immutable tags reserve versions. Rapid merges and replaced pending Actions runs do not lose releases: every run selects the oldest unfinished release, and successful publication starts another scan. A failed release blocks newer releases rather than reassigning its version or moving npm's `latest` out of order.

Retries reuse matching artifacts and reject conflicts. Release assets must match byte-for-byte; published releases missing assets require a new version. npm verification waits up to ten minutes for registry visibility and reports any missing versions.

After fixing a publication failure, run **Publish release artifacts** from `main` without inputs to resume the queue:

```bash
gh workflow run publish.yml --repo leitwerk-dev/leitwerk --ref main
```

To explicitly recheck or resume the latest reserved release, set `TAG` to its `vX.Y.Z` tag:

```bash
gh workflow run publish.yml --repo leitwerk-dev/leitwerk \
  --ref main -f release_tag="$TAG"
```

Historical releases cannot be republished after a newer version is reserved. A new dispatch uses current image build recipes; rerunning an old workflow attempt uses its original recipes. Neither changes the reserved release source or version.

## Registering new npm packages

PR validation and release validation check npm package registration. Before merging a PR that adds package names, run this command from its checkout if the check reports missing names:

```bash
npm run publish:bootstrap
```

Requires npm 11.16+ within npm 11 and `npm login` with 2FA enabled. Run from an interactive terminal on macOS/Linux. The command registers missing names as metadata-only `0.0.0-bootstrap.0` placeholders under `bootstrap`, then uses `npm trust` to configure stable publishing (`leitwerk-dev/leitwerk`, `publish.yml`, `npm-publish`). No build is needed; `latest` and `next` stay unchanged.

Reruns skip registered package names and matching publishers, and resume incomplete trust setup. Conflicting publishers stop setup before writes; they are never overwritten. Authentication prompts, notices, and writes go directly to the terminal. Review npm's confirmation prompts for new publishers. CI checks registration only; the local command also checks publisher settings.

Bootstrap changes also need an authorized live acceptance check: complete interactive bootstrap, inspect the registry's tags and publisher settings, rerun to confirm no writes, and publish through the configured GitHub workflow. Local tests do not establish npm authentication or OIDC compatibility. Do not create packages or change trust settings merely to run the automated suite.

## Version selection

GitHub squash-merges PRs using their titles as commit titles. Each qualifying main commit increments the previous release version according to these [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

| Title | Release effect before 1.0 | Release effect at 1.0 and later |
|---|---:|---:|
| `fix(scope): description` | patch | patch |
| `feat(scope): description` | patch | minor |
| `fix(scope)!: description` | minor | major |
| `feat(scope): description` with a `BREAKING CHANGE:` footer | minor | major |
| `docs`, `test`, `ci`, `build`, `chore`, `refactor`, `perf` | none | none |

An explicit `Release-As: X.Y.Z` footer overrides version selection. It must specify a stable version greater than the previous release. A breaking marker on any supported commit type requests a release. Commit sign-off requirements are documented in [Contributing](https://github.com/leitwerk-dev/leitwerk/blob/main/CONTRIBUTING.md).

Breaking an `@public` API requires release notes and a minor bump before 1.0,
or a major bump from 1.0. Removing its supported classification counts as a
breaking change even when current consumers no longer use it. `@internal`
APIs remain usable without this compatibility promise.

## Release automation

Every release includes all npm workspaces with matching versions and exact internal dependency pins. Release commits update the manifests, lockfile, chart metadata, and root changelog together. A release remains a draft until all artifacts are published and publicly readable.

## Stable release artifacts

- npm: every `@leitwerk-dev/*@X.Y.Z` workspace, with the normal `latest` dist-tag
- Server: `ghcr.io/leitwerk-dev/leitwerk-server:X.Y.Z` and `:<git-sha>`
- Generic worker: `ghcr.io/leitwerk-dev/leitwerk-worker-generic:X.Y.Z` and `:<git-sha>`
- Helm: `oci://ghcr.io/leitwerk-dev/charts/leitwerk:X.Y.Z`

Images support Linux `amd64` and `arm64`. The chart pins them by digest. The GitHub Release includes the chart archive and `leitwerk-base.lock.yaml`, which records the Git SHA and immutable image and chart digests. Publication verifies that every artifact is publicly readable.

## Dependency updates

Renovate applies a [14-day minimum release age](https://docs.renovatebot.com/upgrade-best-practices/#wait-two-weeks-before-automerging-third-party-dependencies)
to routine dependency updates, including majors and weekly lockfile maintenance.
Non-major updates can auto-merge after required checks pass. Major updates require
maintainer approval. Security updates bypass the waiting period.

The hosted [Renovate GitHub App](https://github.com/apps/renovate) reads
`renovate.json` from `main` in `leitwerk-dev/leitwerk`. Install the app for the
`leitwerk-dev` organization with access to this repository. The app manages its
credentials and runs on its hosted schedule; no Actions workflow or repository
token secret is needed. Its dependency PRs trigger validation, including updates
to GitHub Actions. PR creation waits for the release-age check. Since validation
runs on PRs, `internalChecksAsSuccess` lets a passing Renovate release-age check
unblock PR creation before CI starts. Lockfile maintenance runs before 05:00 on
Mondays in `Europe/Berlin`.

For auto-merge, enable **Allow auto-merge** in repository settings and require
**Full validation** and **Conventional PR title and DCO** in the branch rules for
`main`. The bot must satisfy those rules, including any required human review.
Without auto-merge, maintainers merge dependency PRs after the checks pass.

The app creates a **Dependency Dashboard** issue after processing the repository.
Use its checkboxes to request another run or approve a major update. Inspect run
results in the [Mend developer portal](https://developer.mend.io/). For an
immediate run, open the repository there and select **Actions → Run Renovate scan**.
