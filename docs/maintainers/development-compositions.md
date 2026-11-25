# Development compositions

A composition connects an extension workspace, runtime configuration, and optional external test roots without changing core production behavior or the public publish set. For external extension development without a core checkout, see [Development setup](../extensions/development-setup.md).

## Core-maintainer compositions

A core checkout can run dev and full validation against a sibling extension workspace:

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

Manifest schema (`leitwerk.composition.yaml`):

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

- Paths resolve relative to the manifest; `workspace_root` defaults to its directory and `runtime_config` is required.
- `leitwerk.root`, when set, must match the executing core checkout.
- `test_roots` contribute integration, E2E, UI integration, and `*.browser.test.ts` suites.

Run composed commands from the core checkout:

```sh
npm run dev -- --composition=../my-extensions/leitwerk.composition.yaml
npm run test:full -- --composition=../my-extensions/leitwerk.composition.yaml
```

Without `--composition`, core commands validate only the public repository. Composed packages are excluded from public releases and license staging.

### Reload and hooks

- Source dev watches configured extension and workspace packages. Runtime changes preflight before swapping the backend, using an SQLite snapshot and disposable workspace, tree, and Pi directories. Configured storage is untouched, and failed preflight leaves the healthy backend running. Config or manifest changes restart the session; retry failed turns manually after reload.
- Run `leitwerk-dev bundle:check DIRECTORY --config FILE` to boot-check a bundle with external configuration, disposable storage, and background services stopped.
- Extension workspaces may define `leitwerk:before-test` and `leitwerk:after-typecheck` package hooks; see `packages/dev-tools/README.md`.

## Source sandboxes

`npm run dev:sandbox` runs the public source sandbox without provider credentials (`sandbox/README.md`). Custom compositions implement `SandboxCompositionFactory` from `@leitwerk-dev/dev-sandbox` (`packages/dev-sandbox/README.md`) to supply catalogs, scripted Pi behavior, controls, and provider fixtures without placing extension code in `packages/`.

In an extension workspace, declare the sandbox factory and its test directory in the workspace manifest:

```yaml
test_roots:
  - ./sandbox
sandboxes:
  example: ./sandbox/composition.ts
```

Run `leitwerk-dev sandbox` to start the only declared sandbox or pass `--sandbox=NAME` to choose among several. Launcher options such as `--llm=real` and `reset` pass through. Press Ctrl-C to stop it. The sandbox runs from installed packages in release mode; selecting local core uses the source supervisor and built-in source scenarios. Keep local settings in `.leitwerk/sandbox/<name>.yaml` and use a released `@leitwerk-dev/dev-sandbox` matching the other `@leitwerk-dev/*` pins.

## Standalone UI and API prototypes

- **Workflow graph preview (`tools/workflow-graph-prototype`):** `npm run dev:workflow-graph` serves synthetic workflows through `@leitwerk-dev/workflow-graph` on `http://127.0.0.1:4320` with no server or credentials. Validate changes with `npm run check --prefix tools/workflow-graph-prototype` (plus `npm run test:full` if shared `@leitwerk-dev/workflow-graph` changes).
- **API explorer (`tools/api-explorer-prototype`):** Localhost-only workbench (`http://127.0.0.1:4318`) and read-only findings API (`/api/v1/schema`, `/api/v1/findings*`) reading JSON reports from `.leitwerk/api-explorer/reports/` (or `--reports-dir`). Validate confined changes with `npm run check --prefix tools/api-explorer-prototype` and visual browser checks; see `tools/api-explorer-prototype/README.md`.

### Portable API evidence

Generate `catalog.json` and `usage-*.json` reports explicitly after a build (`npm run build` never auto-generates API reports; pass `--output-dir` to write elsewhere):

```sh
npm run build
npm run api:report -- --built
npm run api:report -- --built --composition /path/to/leitwerk.composition.yaml
```

Installed consumers can run `leitwerk-dev api:report --usage-only`. Run `leitwerk-dev api:check --workspace PATH` or `npm run api:check` to validate `@public`/`@internal` export classifications.
