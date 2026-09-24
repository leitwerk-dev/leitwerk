# Development compositions

A composition connects an extension workspace, runtime configuration, and optional
external test roots. It does not change production configuration or the public
publish set.

Choose a development mode before arranging the workspace:

| Mode | Use it for | Dependencies |
| --- | --- | --- |
| Released packages | Normal extension development without a core checkout. | Locked npm releases. |
| Optional local core | Develop an extension and core together. | One consistently linked local public package graph. |
| Core-maintainer composition | Run a core checkout against a separate workspace. | Explicit composition passed to core commands. |

## Released-package development

An extension repository declares only its own packages as npm workspaces and depends
on released `@leitwerk-dev/*` packages. Build and typecheck through package exports,
not relative paths into a core checkout. Commit the npm lockfile.

Install `@leitwerk-dev/dev-tools` and expose command wrappers:

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

```sh
npm ci
npm run dev
```

Development builds and watches the workspace's extensions, restarts the installed
server after successful builds, and serves the installed UI with API/WebSocket
forwarding. `@leitwerk-dev/ui` includes the compiled assets; a core checkout is not
required.

## Optional local core

Keep an optional checkout, for example `.leitwerk-base/`, inside the extension
repository. Select source mode explicitly:

```sh
npm run core:use-local -- --revision <commit-or-tag>
```

On first use the command clones the selected core, installs it, and links its public
packages. Existing checkouts retain their branch and uncommitted edits. Keep ignored
selection metadata separate from committed manifests and the release lockfile.
Do not mix local SDK packages with registry copies of the rest of the public graph.

Subsequent commands delegate to the selected checkout with the composition manifest.
Return to released dependencies with:

```sh
npm run core:use-release
```

This restores the committed installation but retains the checkout. Ordinary dev,
build, or test commands must not clone, fetch, switch branches, or select local core
merely because a checkout exists.

## Core-maintainer composition

A core checkout may execute composed commands against a sibling workspace:

```text
checkout/
├── leitwerk/
└── my-extensions/
    ├── package.json
    ├── package-lock.json
    ├── leitwerk.composition.yaml
    ├── leitwerk.yaml
    ├── packages/
    ├── extensions/
    └── tests/
```

A deliberately composite npm workspace can include sibling core packages, but this
is not the normal released-package layout. Its root owns that composite installation
and lockfile. Each extension still declares its own dependencies. Do not share
`node_modules` or build outputs between concurrent validations.

### Manifest

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
sandboxes:
  example: ./sandbox/example/composition.ts
```

The optional `sandboxes` map names [sandbox compositions](#source-sandbox-compositions).
Paths are relative to the manifest. `workspace_root` defaults to its directory;
`runtime_config` is required. Optional `leitwerk.root` must identify the checkout
executing the command. Extension entries may be paths or installed package names;
package metadata need not be exported. Test roots contribute integration, E2E,
UI integration, and `*.browser.test.ts` tests.

From the core checkout:

```sh
npm run dev -- --composition=../my-extensions/leitwerk.composition.yaml
npm run test:full -- --composition=../my-extensions/leitwerk.composition.yaml
```

Without `--composition`, core commands retain their public-only behavior. Public
publishing and license staging never include private composed packages.

## Reload and verification

Source development watches configured extension and workspace package sources.
Runtime changes preflight before replacing the backend. A failed preflight leaves
the healthy backend running. UI source changes use Vite's development path. Changes
to configuration or extension metadata preflight and restart the development session.

Local workers can load composed source roots. Isolated workers do not receive host
source paths; package the required built artifacts in their images.

The composed full gate includes external builds, TypeScript, tests, boundary checks,
and built extension loading. Repository-specific checks may use `leitwerk:before-test`
and auxiliary type builds may use `leitwerk:after-typecheck` in either dependency mode.
See the [development CLI](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/dev-tools/README.md)
for command and hook contracts.

### Source sandbox compositions

`npm run dev:sandbox` starts the public source sandbox without provider credentials.
Custom compositions supply their catalog, scenarios, scripted Pi, controls, and
provider fixtures. Keep extension behavior outside core packages.

Extension workspaces declare sandbox compositions in the manifest. With the local
core selected, `leitwerk-dev sandbox` starts the only declared sandbox; use
`--sandbox=NAME` when several are declared. Launcher options such as `--llm=real`
and `reset` pass through. The sandbox runs in the foreground; Ctrl-C shuts it down.
Keep local settings in `.leitwerk/sandbox/<name>.yaml`, not tracked files. Depend on a
released `@leitwerk-dev/dev-sandbox` matching the other `@leitwerk-dev/*` pins, not a
`file:` link into the checkout.

The source sandbox requires a core checkout; installed packages do not include its
supervisor, UI source, or built-in scenarios. Follow the
[sandbox guide](https://github.com/leitwerk-dev/leitwerk/blob/main/sandbox/README.md)
and [harness contract](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/dev-sandbox/README.md)
for custom backend composition, startup, and reset. Those guides own the sandbox's
specialized entry-point options.

### Portable API evidence

After a composed build, generate reports explicitly:

```sh
npm run api:report -- --built --composition /path/to/leitwerk.composition.yaml
```

Report generation does not switch dependencies or modify composition repositories.
Builds do not generate reports automatically. Installed consumers can run
`leitwerk-dev api:report --usage-only` instead.

Collect `catalog.json` and `usage-*.json` in the ignored
`.leitwerk/api-explorer/reports/` directory, or select `--output-dir`. The read-only
explorer accepts `--reports-dir`; it does not discover compositions or build packages.
See the [report contract](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/dev-tools/README.md#portable-api-reports).

Use `leitwerk-dev api:check --workspace PATH` for API classification checks without
a core checkout. See [SDK compatibility](process-sdk.md#api-compatibility).
