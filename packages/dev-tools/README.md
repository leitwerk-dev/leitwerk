# Extension development tools

`@leitwerk-dev/dev-tools` provides the `leitwerk-dev` CLI for an extension workspace.
Install it alongside matching `@leitwerk-dev/server`, `@leitwerk-dev/ui` and SDK
versions. Node 26, npm and POSIX are required. Git is needed only for source mode.

```json
{
  "scripts": {
    "dev": "leitwerk-dev dev",
    "build": "leitwerk-dev build",
    "typecheck": "leitwerk-dev typecheck",
    "test:full": "leitwerk-dev test:full",
    "core:status": "leitwerk-dev core:status",
    "core:use-local": "leitwerk-dev core:use-local",
    "core:use-release": "leitwerk-dev core:use-release"
  }
}
```

Commands use the current directory. `--workspace PATH` selects another workspace;
`--composition PATH` selects its manifest, relative to that workspace. Use a
version 1 `leitwerk.composition.yaml` with `runtime_config`, `extensions` and
optional `test_roots`. Extension paths resolve relative to the manifest; package
names resolve through its npm installation. Declare only your own packages in
the workspace's `package.json`. Literal workspace paths, trailing `/*` patterns
and the `{ "packages": [...] }` workspace form are supported.

## Installed packages

The default mode uses installed packages and requires no core checkout.
`build` orders workspace packages by dependency and runs their `build` and
`build:ext-ui` scripts. `typecheck` runs the installed TypeScript project build.
`test:full` runs the workspace's installed Biome, builds, type checks, Vitest and,
when a Playwright configuration exists, Playwright. Install the corresponding
test tools in the workspace; commands never download missing tools through npx.

`dev` builds the extensions, starts the installed server and serves the installed
UI with API, extension UI and WebSocket forwarding. Source, package metadata,
runtime configuration and composition changes rebuild and restart the backend.
Failed builds or invalid configuration leave the running backend available.
Successful configuration edits reread ports and proxy targets. `HOST`, `PORT`,
`LEITWERK_UI_PORT`, `LEITWERK_CONFIG_PATH` and `LEITWERK_BASE_URL` override the
corresponding settings. The UI listens on loopback with strict port selection.
This runner uses your configured application storage and credentials; isolated
scripted scenarios belong to the separate development sandbox.

Repository-specific checks can use two optional npm scripts:

- `leitwerk:before-test` runs after Biome and before full validation in either mode.
- `leitwerk:after-typecheck` runs after successful `typecheck` or `test:full` in
  either mode, for auxiliary TypeScript projects outside the composed packages.

## Local core

```sh
leitwerk-dev core:use-local --revision <commit-or-tag>
leitwerk-dev core:status
leitwerk-dev dev
leitwerk-dev core:use-release
```

On first use, the CLI clones the public repository to `.leitwerk-base` and checks
out the explicit revision on a `development` branch. A `public_git_sha` in the
workspace's `leitwerk-base.lock.yaml` supplies the revision when omitted.
`--checkout PATH` and `--repository URL` select a different checkout and clone
source. Existing checkouts retain their branch, commits and edits; the initial
revision and repository arguments do not retarget an existing checkout.

Selection installs both locked dependency graphs, links every public workspace
package consistently, builds core, and writes ignored selection/composition files
under `.leitwerk`. Manifests and npm lockfiles remain unchanged. The selected
checkout runs `dev`, `build`, `typecheck` and its full composed test gate. Changing
either lockfile or replacing links with a manual npm install requires rerunning
`core:use-local`.

`core:use-release` restores the workspace's locked installation and keeps the
checkout, branches and edits. Existing private-runner selection files remain
readable. Interrupted switches block ordinary commands until a switch succeeds.
Normal commands never clone, fetch, switch branches, or select local mode merely
because a checkout exists.

The package root exports `runDevelopment(command, options)` for repository
wrappers. `/composition` and `/workspace` share manifest parsing and package
discovery with the public source-development commands. The sandbox CLI still
requires the source supervisor; this package does not provide installed-package
sandbox startup.
