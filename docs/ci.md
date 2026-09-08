# CI, dependency updates, and releases

Ordinary merges do not publish artifacts. Release Please collects changes into one release PR; merging it publishes the stable release. Maintainers can explicitly publish npm release candidates from that PR before merging.

Stable releases use one version, `X.Y.Z`, across all npm packages, container images, and the Helm deployment chart. Publication creates the Git tag `vX.Y.Z` and publishes npm packages under `latest`.

Release candidates also use one version, `X.Y.Z-rc.<run-id>`, across every npm package; internal dependencies pin that same version. RCs publish under `next`, leave `latest` unchanged, and include no container images or Helm chart.

## Validation

Every PR must pass `Full validation` and `Conventional PR title and DCO`. These checks cover builds, type checks, tests, PR title format, and commit sign-offs. Publication also validates release metadata and package contents.

## Publication safeguards

Stable publication accepts only releases created from a merged Release Please PR on `main`. RC publication accepts only the validated revision of an open release PR. Both use main-only publishing environments and short-lived npm credentials.

## Retries

Failed publication jobs can be rerun. They reuse matching artifacts and stop on conflicts; published versions are never overwritten. If an RC's release PR changes, start a new workflow run.

## Running an RC

Run **Publish release candidate** from `main` with the open release PR number. By default, it validates and retains package archives. Enable **publish** to publish them under `next`.

```bash
gh workflow run publish-rc.yml --repo leitwerk-dev/leitwerk \
  --ref main -f release_pr=40 -F publish=true
```

Replace `40` with the open release PR number. Omit `-F publish=true` to validate without publishing.

## Version selection

GitHub squash-merges PRs using their titles as commit titles. Release Please derives versions from these [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

| Title | Release effect before 1.0 | Release effect at 1.0 and later |
|---|---:|---:|
| `fix(scope): description` | patch | patch |
| `feat(scope): description` | patch | minor |
| `fix(scope)!: description` | minor | major |
| `feat(scope): description` with a `BREAKING CHANGE:` footer | minor | major |
| `docs`, `test`, `ci`, `build`, `chore`, `refactor`, `perf` | none | none |

An explicit `Release-As: X.Y.Z` footer overrides version selection. Commit sign-off requirements are documented in [Contributing](https://github.com/leitwerk-dev/leitwerk/blob/main/CONTRIBUTING.md).

## Release automation

`release-please.yml` updates package versions, internal dependencies, the lockfile, chart metadata, and changelog together. A maintainer approves release-PR CI runs when GitHub requires it. The PR body retains the component metadata Release Please uses to create the release. After merge, Release Please creates the GitHub Release and dispatches `publish.yml`.

## Stable release artifacts

- npm: every `@leitwerk-dev/*@X.Y.Z` workspace, with the normal `latest` dist-tag
- Server: `ghcr.io/leitwerk-dev/leitwerk-server:X.Y.Z` and `:<git-sha>`
- Generic worker: `ghcr.io/leitwerk-dev/leitwerk-worker-generic:X.Y.Z` and `:<git-sha>`
- Helm: `oci://ghcr.io/leitwerk-dev/charts/leitwerk:X.Y.Z`

Images support Linux `amd64` and `arm64`. The chart pins them by digest. The GitHub Release includes the chart archive and `leitwerk-base.lock.yaml`, which records the Git SHA and immutable image and chart digests. Publication verifies that every artifact is publicly readable.

## Dependency updates

Renovate opens dependency-update PRs. Routine non-major updates become eligible for auto-merge once the dependency release is seven days old and checks pass. Major updates require maintainer approval. Security updates bypass the waiting period.
