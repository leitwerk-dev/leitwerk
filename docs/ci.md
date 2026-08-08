# CI, dependency updates, and releases

Leitwerk releases are maintainer-controlled. Ordinary merges update one Release Please pull request. They do not publish artifacts. Merging that release pull request creates one tag and one GitHub Release, which starts publication.

## Required pull request policy

GitHub accepts squash merges only. Configure the repository to use the pull request title as the default squash commit title. The `Conventional PR title and DCO` check validates every pull request title and every commit sign-off.

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

| Title | Release effect before 1.0 | Release effect at 1.0 and later |
|---|---:|---:|
| `fix(scope): description` | patch | patch |
| `feat(scope): description` | patch | minor |
| `fix(scope)!: description` | minor | major |
| `feat(scope): description` with a `BREAKING CHANGE:` footer | minor | major |
| `docs`, `test`, `ci`, `build`, `chore`, `refactor`, `perf` | none | none |

Scopes are optional. Use a `Release-As: 1.0.0` footer when maintainers deliberately select an exact version.

Every human and bot commit must contain a `Signed-off-by` trailer matching its author. Humans normally use `git commit -s`. Release Please derives its trailer from the GitHub App ID and slug at runtime. Renovate uses its `:gitSignOff` preset.

Enable compulsory web sign-off in GitHub so the squash commit created by GitHub is also signed off. Require these checks before merge:

- `Full validation`
- `Conventional PR title and DCO`

Allow platform auto-merge so Renovate can merge eligible updates after required checks pass.

## Release Please

`.github/workflows/release-please.yml` runs on each push to `main`. It uses `release-please-config.json` and `.release-please-manifest.json` to create or update one release pull request. Merging an ordinary pull request only updates that release pull request. Merging the generated release pull request causes Release Please to create `vX.Y.Z` and one GitHub Release.

The release group contains the root and every npm workspace. `node-workspace` updates package manifests, exact internal dependency versions, and `package-lock.json`. `linked-versions` assigns the same version to every component. Only the root component writes `CHANGELOG.md` or creates a tag and GitHub Release.

The initial history boundary is `0d650094f359c0c8686b5ec0928a607d44fcc866`. Existing non-Conventional history is excluded. The first proposed release is `v0.1.0`.

Create a GitHub App dedicated to Release Please. Install it only on this repository and grant only:

- Contents: read and write
- Pull requests: read and write
- Issues: read and write, for release labels
- Metadata: read

Store its numeric ID as `RELEASE_PLEASE_APP_ID` and its private key as `RELEASE_PLEASE_APP_PRIVATE_KEY`. The workflow requests an installation token limited to the `leitwerk` repository. Do not replace it with `GITHUB_TOKEN`: resources created with `GITHUB_TOKEN` do not trigger the pull request and release workflows needed by this design.

## Publication

`.github/workflows/publish.yml` runs when Release Please publishes a GitHub Release. It validates the tag and then runs:

```bash
npm run release:check
npm run test:full
npm run docs:build
npm run publish:dry-run
```

The release contract requires one `X.Y.Z` across the root, all 22 workspace manifests, exact internal dependencies, `package-lock.json`, Helm `version` and `appVersion`, and the chart's source server and generic-worker image tags.

Publication produces these public coordinates:

- npm: every `@leitwerk-dev/*@X.Y.Z` workspace, with the normal `latest` dist-tag
- Server: `ghcr.io/leitwerk-dev/leitwerk-server:X.Y.Z` and `:<git-sha>`
- Generic worker: `ghcr.io/leitwerk-dev/leitwerk-worker-generic:X.Y.Z` and `:<git-sha>`
- Helm: `oci://ghcr.io/leitwerk-dev/charts/leitwerk:X.Y.Z`
- Git: `vX.Y.Z`

Both images are Linux multi-architecture indexes containing `amd64` and `arm64`. The workflow creates no mutable `latest`, major, or minor image aliases. The packaged chart replaces the source image tags with the image digests produced by the same run. It records the Git SHA and image digests in chart annotations.

The workflow anonymously reads all npm packages, both image manifests, and the chart before declaring success. It attaches `leitwerk-X.Y.Z.tgz` and `leitwerk-base.lock.yaml` to the GitHub Release. The lock records the Git SHA and immutable image and chart digests.

Configure npm trusted publishing for each workspace with:

- Organization: `leitwerk-dev`
- Repository: `leitwerk`
- Workflow: `publish.yml`
- Environment: `npm-publish`
- Allowed action: `npm publish`

The workflow uses a GitHub-hosted runner, npm 11, and `id-token: write`. It has no npm token. Make the two image packages and `charts/leitwerk` public in GHCR before the first release.

## Retry and conflicts

Cross-registry publication is not atomic. To resume a partial publication, manually dispatch `Publish release artifacts` with an existing tag such as `v0.1.0`.

The retry checks every existing artifact before reusing it:

- npm packages must report the release Git SHA in `gitHead`;
- image version and Git-SHA tags must carry the release revision label, contain both architectures, and resolve to one digest;
- the chart must record the release Git SHA and the selected image digests;
- an existing release lock must name the same Git SHA.

A matching artifact is reused. Missing npm packages are published, and missing image aliases are created from the matching digest. Any coordinate owned by another revision stops the run. Published versions are never overwritten.

## Renovate

`renovate.json` extends `config:best-practices` and `:gitSignOff`. The preset pins Docker images and GitHub Actions by digest and performs weekly lockfile maintenance. Repository rules group runtime npm dependencies, development tooling, CI actions, and container or Helm dependencies.

Runtime and container updates use `fix(deps)` and contribute a patch release. Development updates use `chore(deps)` and workflow updates use `ci(deps)`. Release Please owns internal `@leitwerk-dev/*` versions and official Leitwerk image coordinates, so Renovate excludes them.

Minor, patch, pin, digest, and lockfile updates are eligible for platform auto-merge after seven days and all required checks. Major updates require Dependency Dashboard approval and manual merge. Vulnerability pull requests bypass schedules and open immediately; only non-major updates inherit auto-merge eligibility.

## Initial rollout

Before merging the first `v0.1.0` release pull request:

1. Enable squash-only merges, title-based squash messages, compulsory web DCO sign-off, platform auto-merge, and the required checks.
2. Install the narrowly scoped Release Please App and add its two secrets.
3. Install Renovate and confirm a generated pull request passes the title and DCO check.
4. Create or configure all npm packages with trusted publishers.
5. Permit GHCR package creation and make the image and chart packages public.
6. Review the generated root changelog, all lockstep version edits, and the proposed `0.1.0` version.
