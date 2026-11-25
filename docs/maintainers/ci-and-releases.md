# CI, dependency updates, and releases

Every merge to `main` that increments the version publishes a stable release (`X.Y.Z`) across all `@leitwerk-dev/*` npm packages, server and generic-worker container images, and the Helm chart. Non-release changes do not publish artifacts.

## Required pull request checks

Every PR must pass two required checks (see `CONTRIBUTING.md`):

1. **`Full validation`:** Runs application validation (`npm run publish:registration`, `npm run test:full`, `npm run api:check`, `npm run docs:build`, `npm run publish:dry-run`, plus `helm version --short` and a non-blocking 5% test-runtime regression check against the last 10 `main` runs) and image validation (Docker Buildx `build` targets for server and generic worker) in parallel. Both jobs must succeed.
2. **`Conventional PR title and DCO`:** Validates the Conventional Commits PR title and `Signed-off-by` trailers on all commits (`git commit -s`).

CI runs on Node 26 across Chromium, Firefox, and WebKit. `npm run api:check` validates `@public`/`@internal` annotations and public signature dependencies against built `dist/` outputs.

## Documentation site

The `Docs` workflow (`.github/workflows/docs.yml`) runs `npm run docs:build` on every push to `main` and on manual dispatch, then deploys `site/` to GitHub Pages at <https://leitwerk-dev.github.io/leitwerk/>. Pull requests only build the site, inside `Full validation`. Repository Pages settings must use **GitHub Actions** as the source.

## Version selection

GitHub squash-merges PRs using their PR title as the commit subject. Under `release-policy.json` (`releaseAllTypes: true`), Conventional Commits select the next version from the previous release:

| PR title | Pre-1.0 effect | 1.0+ effect |
| --- | --- | --- |
| `fix`, `ci`, `build`, `chore`, `refactor`, `perf`, `revert` | patch | patch |
| `feat(scope): description` | patch | minor |
| `fix(scope)!: description` or `BREAKING CHANGE:` footer | minor | major |
| `docs`, `test` (without breaking marker) | none | none |

`Release-As: X.Y.Z` overrides version selection to an explicit version greater than the previous release. Breaking an `@public` API (including removing support or demoting a `@public` tag) requires release notes and a breaking marker.

## Release automation and retries

- Publication runs automatically after `main` push CI passes and via 15-minute scheduled queue drains; there is no manual dispatch or direct tag push trigger.
- Releases publish serially in `main`'s first-parent order using immutable `vX.Y.Z` tags. `RELEASE_TAG_KEY` in `npm-publish` bypasses `automation-only-release-tags` along with all write-enabled deploy keys (so write-enabled deploy keys must be audited as release infrastructure); `immutable-release-tags` denies tag updates or deletes even for automation. A failed release blocks newer releases until a fix merges to `main`.
- Stable images build verified release-tag application source with `main`'s Dockerfiles so Dockerfile fixes can resume a draft release without changing its tag.
- All npm packages must be publicly readable before container images or Helm charts publish, and the GitHub Release stays a draft until anonymous reads succeed for every artifact.
- Retries reuse matching artifacts and reject conflicts: OCI chart files must match (archive timestamps may differ), release assets must match byte-for-byte, duplicate npm transparency-log conflicts retry up to 3 times, and npm registry visibility waits up to 10 minutes. Release commits attach to tags without pushing back to `main`.

### Stable release artifacts

- **npm:** every `@leitwerk-dev/*@X.Y.Z` workspace under `latest` (with provenance).
- **Images (Linux `amd64`/`arm64`):** `ghcr.io/leitwerk-dev/leitwerk-server:X.Y.Z` and `ghcr.io/leitwerk-dev/leitwerk-worker-generic:X.Y.Z` (plus `:<git-sha>`).
- **Helm chart:** `oci://ghcr.io/leitwerk-dev/charts/leitwerk:X.Y.Z` with digest-pinned default images, attached chart archive, and `leitwerk-base.lock.yaml`.

### Registering new npm packages

Before merging a PR that introduces a new `@leitwerk-dev/*` workspace name, run `npm run publish:bootstrap` from an interactive terminal with npm `11.16+` (within npm 11), `npm login`, and 2FA. It publishes metadata-only `0.0.0-bootstrap.0` placeholders under `bootstrap` (leaving `latest` and `next` untouched), configures `npm trust` for `leitwerk-dev/leitwerk` / `publish.yml` / `npm-publish`, and stops without overwriting conflicting publishers.

CI verifies registration (`npm run publish:registration`) without modifying registry state.

## Dependency updates

Renovate (`renovate.json`) runs via the hosted Renovate GitHub App (no Actions workflow or repository secret; trigger immediate scans from the Dependency Dashboard issue or Mend developer portal). It enforces a 14-day minimum release age on routine updates, auto-merging non-major updates once required checks pass and requiring maintainer approval for major updates; security updates bypass the waiting period.
