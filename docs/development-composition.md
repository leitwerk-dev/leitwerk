# Development Compositions

A development composition declares an extension workspace and its runtime configuration. Extension workspaces can use published npm packages without a core checkout. When a core checkout executes a composed command, it includes the workspace in source development and full validation. The manifest does not change production configuration or the public publish set.

## Installed packages and optional source development

An extension repository should declare only its own packages as npm workspaces and depend on released `@leitwerk-dev/*` packages normally. Build and TypeScript configuration should use package exports, not references into a core checkout. The committed npm lockfile records the released dependency graph.

Keep an optional core clone inside the extension repository, for example `.leitwerk-base/`. `@leitwerk-dev/dev-tools` supplies `leitwerk-dev core:use-local` to clone the matching release on first use, install its dependencies, and link the public packages into the extension workspace. Existing checkouts retain their branch and uncommitted edits. Activate the entire local public package graph consistently for runtime, types, and tests; do not mix registry copies with local SDK packages. Keep selection metadata ignored and leave the committed package manifests and release lock unchanged.

`core:use-release` restores the committed npm installation and retains the checkout. Normal development commands must not clone, fetch, switch branches, or select source mode merely because a checkout exists. Each extension repository owns its own optional checkout and selection.

The runtime and extension APIs are available from installed `@leitwerk-dev/server` and `@leitwerk-dev/extension-runtime` packages. `@leitwerk-dev/ui` includes compiled UI assets. `leitwerk-dev dev` builds and watches workspace extensions, restarts the installed server after successful builds, and serves the installed UI with API/WebSocket forwarding. See the [development CLI](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/dev-tools/README.md) for commands, dependency selection and repository hooks. Core source development continues to use this repository's `dev` command.

Run `leitwerk-dev api:check --workspace PATH` to check the workspace's API
classifications without a core checkout. `@public` and `@internal` both remain
usable; the tags state the
[SDK compatibility contract](process-sdk.md#api-compatibility).

## Layout

Keep the public and private repositories as siblings:

```text
checkout/
├── leitwerk/
└── leitwerk-private/
    ├── package.json
    ├── package-lock.json
    ├── leitwerk.composition.yaml
    ├── leitwerk.yaml
    ├── packages/
    ├── extensions/
    └── tests/
```

The private root owns the composite npm lockfile. Its workspace may include sibling Leitwerk packages:

```json
{
  "private": true,
  "workspaces": [
    "packages/*",
    "extensions/*",
    "../leitwerk/packages/*",
    "../leitwerk/extensions/*"
  ]
}
```

An extension continues to own its dependencies in its own `package.json`. npm links dependency versions satisfied by a local workspace and installs all other dependencies normally.

## Manifest

```yaml
version: 1
leitwerk:
  root: ../leitwerk
workspace_root: .
runtime_config: ./leitwerk.yaml
extensions:
  - ./extensions/example
test_roots:
  - ./tests
```

An optional `sandboxes` map names [sandbox compositions](#source-sandbox-compositions).
Paths are relative to the manifest. `leitwerk.root` is optional; when present it must identify the checkout executing the command, otherwise that checkout is used. `workspace_root` defaults to the manifest directory. `runtime_config` is required. Listed extensions can be filesystem paths or installed package names such as `@leitwerk-dev/coding`; package metadata need not be exported. They are added to the development extension catalog. Test roots contribute integration, E2E, UI integration, and `*.browser.test.ts` Playwright tests.

## Commands

Install `@leitwerk-dev/dev-tools` in the extension workspace and expose wrappers:

```json
{
  "scripts": {
    "dev": "leitwerk-dev dev",
    "build": "leitwerk-dev build",
    "typecheck": "leitwerk-dev typecheck",
    "test:full": "leitwerk-dev test:full",
    "core:use-local": "leitwerk-dev core:use-local",
    "core:use-release": "leitwerk-dev core:use-release"
  }
}
```

`npm ci` and `npm run dev` use released packages. `npm run core:use-local --
--revision <commit-or-tag>` explicitly selects source development. Subsequent
commands delegate to that checkout with the composed manifest. Repository tooling
checks can use `leitwerk:before-test`; auxiliary type builds can use
`leitwerk:after-typecheck`. The CLI's full gate includes these hooks in both modes.

Without `--composition`, every Leitwerk command retains its public-only behavior.
In-checkout packages share `scripts/tsup-config.ts` defaults, tracked by Turbo's global cache inputs; workspace configs retain entry points and overrides. External repositories own their build configs.

## Reload and verification

Source development watches composed extension sources and private workspace package sources. Runtime changes preflight and restart the backend. Extension UI sources use the existing Vite development lane. Local workers receive the resolved composition roots so they can load extension entries from the sibling workspace. Isolated workers do not receive host development roots.

Composition-aware build and verification include external package builds, TypeScript projects, source aliases, unit and integration tests, private test roots, boundary checks, and dist extension catalog loading. Public publishing and public license staging never include composed packages.

Development, release, boundary checks, and source aliases share workspace discovery. It accepts `workspaces` arrays or `{ "packages": [...] }`, expands literal package paths and trailing `/*` patterns, and deduplicates directories containing `package.json`.

### Development backend composition

The source supervisor accepts `LEITWERK_DEV_BACKEND_ENTRY`, an absolute backend
entry path, and `LEITWERK_DEV_PREFLIGHT_ENTRY`, a matching preflight entry.
The defaults remain the normal server and preflight scripts. A custom preflight
must validate its composition without opening the application's persistent database
for writing. The supervisor watches the backend entry and configured extension
sources and retains its normal graceful restart and readiness handling.
Both backend source reload and the outer configuration/metadata reload use the
same custom preflight entry.
`LEITWERK_DEV_WATCH_PATHS_JSON` adds source paths as a JSON array, allowing a
development harness outside application packages to participate in backend reloads.

`LEITWERK_UI_HOST` selects the Vite development listener host; it defaults to
`localhost`. These are development environment variables, not production server
configuration or extension-discovery overrides.

### Source sandbox compositions

`npm run dev:sandbox` starts the public notebook composition without provider
credentials. `@leitwerk-dev/dev-sandbox` supplies `createSandboxApp` and the source
launcher/reset entrypoints. A `SandboxCompositionFactory` receives isolated paths,
mode and configured URLs, then supplies process configuration, an explicit catalog,
scenarios, scripted Pi, controls, polling and cleanup. Adapters own their persisted
state. Core harness code and tests import no extensions; built-in scenarios live
in the checkout's `sandbox/` tooling.

Extension workspaces declare their compositions in the manifest:

```yaml
sandboxes:
  example: ./sandbox/example/composition.ts
```

With the local core selected, `leitwerk-dev sandbox` starts the only declared
sandbox. `--sandbox=NAME` selects one of several; launcher options such as
`--llm=real` and `reset` pass through. The command runs the checkout's
`scripts/sandbox/cli.ts --composition=<manifest>` in the foreground, so the launcher
receives interrupts directly and keeps its shutdown record. Keep sandbox
settings in `.leitwerk/sandbox/<name>.yaml`, never in tracked files. Depend on a
released `@leitwerk-dev/dev-sandbox` that matches your other `@leitwerk-dev/*`
pins, not on a `file:` link into the checkout. This phase supports source
development only; an installed package does not contain the supervisor, UI source
or built-in scenarios. See the [sandbox guide](https://github.com/leitwerk-dev/leitwerk/blob/main/sandbox/README.md)
and [harness contract](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/dev-sandbox/README.md).

### Portable API evidence

After a successful composed build, generate reports explicitly:

```sh
npm run api:report -- --built --composition /path/to/leitwerk.composition.yaml
```

The generator reuses composition package and test-root discovery. It does not switch
selected dependencies or modify composition repositories. Builds do not generate
reports automatically. Consumers can run the installed development-tools
`leitwerk-dev api:report --usage-only` command, or invoke a local checkout with
`npm --prefix /path/to/leitwerk run api:report -- --workspace /path/to/consumer --usage-only`.

Collect `catalog.json` and `usage-*.json` in the main checkout's ignored
`.leitwerk/api-explorer/reports/` directory, or choose `--output-dir` explicitly.
The API explorer accepts only `--reports-dir`; it does not discover compositions,
build packages, or access originating source directories. See the
[development-tools report contract](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/dev-tools/README.md#portable-api-reports).
