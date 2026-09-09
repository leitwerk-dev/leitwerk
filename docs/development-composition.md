# Development Compositions

A development composition declares an extension workspace and its runtime configuration. Extension workspaces can use published npm packages without a core checkout. When a core checkout executes a composed command, it includes the workspace in source development and full validation. The manifest does not change production configuration or the public publish set.

## Installed packages and optional source development

An extension repository should declare only its own packages as npm workspaces and depend on released `@leitwerk-dev/*` packages normally. Build and TypeScript configuration should use package exports, not references into a core checkout. The committed npm lockfile records the released dependency graph.

Keep an optional core clone inside the extension repository, for example `.leitwerk-base/`. A repository-owned `core:use-local` command can clone the matching release on first use, install its dependencies, and link the public packages into the extension workspace. Existing checkouts retain their branch and uncommitted edits. Activate the entire local public package graph consistently for runtime, types, and tests; do not mix registry copies with local SDK packages. Keep selection metadata ignored and leave the committed package manifests and release lock unchanged.

`core:use-release` restores the committed npm installation and retains the checkout. Normal development commands must not clone, fetch, switch branches, or select source mode merely because a checkout exists. Each extension repository owns its own optional checkout and selection.

The runtime and extension APIs are available from installed `@leitwerk-dev/server` and `@leitwerk-dev/extension-runtime` packages. `@leitwerk-dev/ui` includes compiled UI assets. A repository runner can build and watch its extensions, restart the installed server after successful builds, and serve the installed UI with API/WebSocket forwarding. Core source development continues to use this repository's `dev` command.

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

Paths are relative to the manifest. `leitwerk.root` is optional; when present it must identify the checkout executing the command, otherwise that checkout is used. `workspace_root` defaults to the manifest directory. `runtime_config` is required. Listed extensions can be filesystem paths or installed package names such as `@leitwerk-dev/coding`; package metadata need not be exported. They are added to the development extension catalog. Test roots contribute integration, E2E, UI integration, and `*.browser.test.ts` Playwright tests.

## Commands

The private repository should expose wrappers:

```json
{
  "scripts": {
    "dev": "LEITWERK_COMPOSITION_PATH=$PWD/leitwerk.composition.yaml npm --prefix ../leitwerk run dev",
    "build": "LEITWERK_COMPOSITION_PATH=$PWD/leitwerk.composition.yaml npm --prefix ../leitwerk run build",
    "typecheck": "LEITWERK_COMPOSITION_PATH=$PWD/leitwerk.composition.yaml npm --prefix ../leitwerk run typecheck",
    "test:full": "LEITWERK_COMPOSITION_PATH=$PWD/leitwerk.composition.yaml npm --prefix ../leitwerk run test:full"
  }
}
```

Run integrated commands from the private root:

```bash
npm install
npm run dev
npm run test:full
```

Install the public checkout separately after public dependency changes:

```bash
npm ci --prefix ../leitwerk
```

Without `--composition`, every Leitwerk command retains its public-only behavior.

## Reload and verification

Source development watches composed extension sources and private workspace package sources. Runtime changes preflight and restart the backend. Extension UI sources use the existing Vite development lane. Local workers receive the resolved composition roots so they can load extension entries from the sibling workspace. Isolated workers do not receive host development roots.

Composition-aware build and verification include external package builds, TypeScript projects, source aliases, unit and integration tests, private test roots, boundary checks, and dist extension catalog loading. Public publishing and public license staging never include composed packages.

Development, release, boundary checks, and source aliases share workspace discovery. It accepts `workspaces` arrays or `{ "packages": [...] }`, expands literal package paths and trailing `/*` patterns, and deduplicates directories containing `package.json`.
