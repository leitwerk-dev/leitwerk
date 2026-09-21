# CI, dependency updates, and releases

Ordinary merges do not publish artifacts. Release Please collects changes into one release PR; merging it publishes the stable release. Maintainers can explicitly publish npm release candidates from that PR before merging.

Stable releases use one version, `X.Y.Z`, across all npm packages, container images, and the Helm deployment chart. Release Please creates tag `vX.Y.Z` and a draft GitHub Release. CI publishes npm packages under `latest`, attaches the chart and lock file, then publishes the draft.

Release candidates also use one version, `X.Y.Z-rc.<run-id>`, across every npm package; internal dependencies pin that same version. RCs publish under `next`, leave `latest` unchanged, and include no container images or Helm chart.

## Validation

Every PR must pass `Full validation` and `Conventional PR title and DCO`. These checks cover builds, type checks, tests, PR title format, and commit sign-offs. Publication also validates release metadata and package contents.

CI and publication workflows run `npm run api:check` as a required step after
`npm run test:full`; the local full gate does not include it. It checks explicit
`@public`/`@internal` annotations and public signature dependencies. Both
classifications remain in published declarations.

Builds, tests, and browser installation use Node 26. Playwright 1.63 supports
fresh browser archive extraction on Node 26.8.1, so the older temporary Node 24
installer workaround is no longer needed. Validation installs Chromium, Firefox,
and WebKit and runs the browser suite in all three engines. Browser installation
retains a five-minute timeout.

## Publication safeguards

Stable publication accepts only releases created from a merged Release Please PR on `main`. RC publication accepts only the validated revision of an open release PR. Both use main-only publishing environments and short-lived npm credentials.

## Retries

Retries reuse matching artifacts and reject conflicts. Release assets must match byte-for-byte; published releases missing assets require a new version. Stable npm verification polls missing versions every 15 seconds for ten minutes and lists any remaining at timeout. If an RC's release PR changes, start a new run.

## Registering new npm packages

Release PRs run **npm package registration**. If names are missing, its summary lists them and provides this command to run from the PR checkout:

```bash
npm run publish:bootstrap
```

Requires npm 11.16+, the macOS/Linux `script` utility, and `npm login` with 2FA enabled. The command registers missing names as metadata-only `0.0.0-bootstrap.0` placeholders under `bootstrap`, then uses `npm trust` to configure stable publishing (`leitwerk-dev/leitwerk`, `publish.yml`, `npm-publish`). No build is needed; `latest` and `next` stay unchanged.

Reruns skip matching publishers and resume incomplete setup. Conflicting publishers and unrecognized trust output stop setup. CI checks registration only; the local command also checks publisher settings. npm currently allows one publisher per package, so the separate RC workflow cannot share this stable configuration.

Bootstrap changes also need an authorized live acceptance check: complete interactive bootstrap, inspect the registry's tags and publisher settings, rerun to confirm no changes, and publish through the configured GitHub workflow. Local tests do not establish npm authentication or OIDC compatibility. Do not create packages or change trust settings merely to run the automated suite.

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

Breaking an `@public` API requires release notes and a minor bump before 1.0,
or a major bump from 1.0. Removing its supported classification counts as a
breaking change even when current consumers no longer use it. `@internal`
APIs remain usable without this compatibility promise.

## Release automation

`release-please.yml` updates package versions, internal dependencies, the lockfile, chart metadata, and changelog together. A maintainer approves release-PR CI runs when GitHub requires it. The PR body retains the component metadata Release Please uses to create the release. After merge, Release Please creates the tag and draft GitHub Release, then dispatches `publish.yml`. The release stays a draft until artifact publication succeeds.

## Stable release artifacts

- npm: every `@leitwerk-dev/*@X.Y.Z` workspace, with the normal `latest` dist-tag
- Server: `ghcr.io/leitwerk-dev/leitwerk-server:X.Y.Z` and `:<git-sha>`
- Generic worker: `ghcr.io/leitwerk-dev/leitwerk-worker-generic:X.Y.Z` and `:<git-sha>`
- Helm: `oci://ghcr.io/leitwerk-dev/charts/leitwerk:X.Y.Z`

Images support Linux `amd64` and `arm64`. The chart pins them by digest. The GitHub Release includes the chart archive and `leitwerk-base.lock.yaml`, which records the Git SHA and immutable image and chart digests. Publication verifies that every artifact is publicly readable.

## Dependency updates

Renovate opens dependency-update PRs. Routine non-major updates become eligible for auto-merge once the dependency release is seven days old and checks pass. Major updates require maintainer approval. Security updates bypass the waiting period.
