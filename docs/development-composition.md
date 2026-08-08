# Development Compositions

A development composition combines this Leitwerk checkout with packages and extensions from a separate npm workspace. It is a development and test input. It does not change production configuration or the public publish set.

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

Paths are relative to the manifest. `leitwerk.root` must identify the checkout executing the command. `workspace_root` defaults to the manifest directory. `runtime_config` is required. Listed extensions are added to the development extension catalog. Test roots contribute integration, E2E, UI integration, and `*.browser.test.ts` Playwright tests.

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
