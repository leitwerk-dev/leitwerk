# CI, dependency updates, and releases

Leitwerk releases are maintainer-controlled. Ordinary merges update one Release Please pull request. They do not publish artifacts. Merging that release pull request creates one tag and one GitHub Release, which starts publication.

Builds and tests run on Node 26. CI and release validation temporarily use Node 24 to
install Playwright browsers: the bundled archive extractor does not complete under Node
26. They restore Node 26 immediately after installation. Browser installation has a
five-minute timeout so an installer regression cannot leave validation running indefinitely.
Publishable workspaces must declare the same Node engine range as the root package.

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

Every human and bot commit must contain a `Signed-off-by` trailer matching its author. Humans normally use `git commit -s`. Release Please uses the standard `github-actions[bot]` identity and a matching static trailer. Renovate uses its `:gitSignOff` preset.

Enable compulsory web sign-off in GitHub so the squash commit created by GitHub is also signed off. Require these checks before merge:

- `Full validation`
- `Conventional PR title and DCO`

Allow platform auto-merge so Renovate can merge eligible updates after required checks pass.

## Release Please

`.github/workflows/release-please.yml` runs on each push to `main` and supports manual dispatch for recovery. It uses `release-please-config.json` and `.release-please-manifest.json` to create or update one release pull request. Merging an ordinary pull request only updates that release pull request. Merging the generated release pull request causes Release Please to create `vX.Y.Z` and one GitHub Release.

The release group contains the root and every npm workspace. `node-workspace` updates package manifests, exact internal dependency versions, and `package-lock.json`. `linked-versions` assigns the same version to every component. Only the root component writes `CHANGELOG.md` or creates a tag and GitHub Release. After Release Please creates or updates the grouped pull request, the workflow inserts the newest root `CHANGELOG.md` entry as overall notes while retaining Release Please's per-component sections. The retained sections are machine-readable release metadata and must remain in the pull request body so Release Please can create the tag and GitHub Release after merge.

The initial history boundary is `0d650094f359c0c8686b5ec0928a607d44fcc866`. Existing non-Conventional history is excluded. The manifest records the 22 npm packages already published as `0.1.0` from that revision. The first integrated GitHub, npm, image, and chart release is therefore `v0.1.1`.

Release Please uses the repository's short-lived `GITHUB_TOKEN`; no Release Please credential is stored. Grant its job only contents, pull-request, and issue write access. Enable **Allow GitHub Actions to create and approve pull requests** in the repository's Actions settings.

GitHub places workflows caused by a `GITHUB_TOKEN`-created or updated pull request into an approval-required state. A maintainer approves the latest generated release-PR workflows before merging it. Other events caused by `GITHUB_TOKEN`, including the GitHub Release event, do not start workflows. The Release Please workflow therefore reads the action's `release_created` and `tag_name` outputs and explicitly dispatches `publish.yml`. GitHub permits `workflow_dispatch` events created with `GITHUB_TOKEN`.

## Publication

`.github/workflows/publish.yml` is dispatched with the new tag immediately after Release Please creates the GitHub Release. It validates the tag and then runs:

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

Both images are Linux multi-architecture indexes containing `amd64` and `arm64`. The
workflow builds each platform concurrently on its matching native GitHub-hosted runner,
pushes the results by digest, and creates the two public aliases only after both platform
builds succeed. Per-image, per-platform BuildKit caches accelerate later releases without
participating in artifact identity or correctness. The workflow creates no architecture,
mutable `latest`, major, or minor image aliases.

The packaged chart replaces the source image tags with the image digests produced by the
same run. It records the Git SHA and image digests in chart annotations.

The workflow anonymously reads all npm packages, both image manifests, and the chart before declaring success. It attaches `leitwerk-X.Y.Z.tgz` and `leitwerk-base.lock.yaml` to the GitHub Release. The lock records the Git SHA and immutable image and chart digests.

Configure npm trusted publishing for each workspace with:

- Organization: `leitwerk-dev`
- Repository: `leitwerk`
- Workflow: `publish.yml`
- Environment: `npm-publish`
- Allowed action: `npm publish`

The workflow uses a GitHub-hosted runner, npm 11, and `id-token: write`. It has no npm token. Make the two image packages and `charts/leitwerk` public in GHCR before the first release.

Restrict the `npm-publish` environment to the exact `main` branch, not tags or pull request
branches. Publication is dispatched from `main`; checking out a release tag does not change
the workflow's deployment branch. The trusted publication workflow verifies that the stable
GitHub Release was created by `github-actions[bot]` and that its tag resolves to the merge
commit of a same-repository Release Please PR targeting `main`. The commit must still be
on `main`. All later jobs check out that verified SHA, not the mutable tag reference.
Verification runs before release code or registry writes. Manual dispatch can resume such
a release; it cannot publish an arbitrary tag or an unmerged release PR. Prerelease npm
publication is not enabled.

## Retry and conflicts

Cross-registry publication is not atomic. If a publication attempt fails for an external
or transient reason and its workflow definition is still correct, rerun its failed jobs.
This preserves the successful validation job and resumes from the artifact checks. If the
workflow implementation changed after the failure, manually dispatch `Publish release
artifacts` with the existing tag, such as `v0.1.1`, so the repaired workflow definition is
used.

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

Before merging the first integrated `v0.1.1` release pull request:

1. Enable squash-only merges, title-based squash messages, compulsory web DCO sign-off, platform auto-merge, and the required checks.
2. Allow GitHub Actions to create pull requests and confirm a maintainer can approve the generated release-PR workflow runs.
3. Install Renovate and confirm a generated pull request passes the title and DCO check.
4. Create or configure all npm packages with trusted publishers.
5. Permit GHCR package creation and make the image and chart packages public.
6. Review the generated root changelog, all lockstep version edits, and the proposed `0.1.0` version.
