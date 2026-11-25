# Development setup

Use released npm packages to build and run an extension in its own workspace. You’ll need macOS or Linux with Node.js 26, npm, OpenSSL, and access to an LLM provider. This example uses an OpenAI API key. See [Models & gateways](../admin/models.md) for other providers.

## Start with released packages

Start by creating the workspace and its first extension directory.

```sh
mkdir -p leitwerk-extensions/extensions/first-process/src
cd leitwerk-extensions
```

Save this as the root `package.json`. The example uses release `0.4.0`. Keep the Leitwerk package versions in sync when upgrading.

```json
{
  "name": "leitwerk-extensions",
  "private": true,
  "workspaces": ["extensions/*"],
  "scripts": {
    "dev": "leitwerk-dev dev",
    "build": "leitwerk-dev build"
  },
  "dependencies": {
    "@leitwerk-dev/models": "0.4.0",
    "@leitwerk-dev/server": "0.4.0",
    "@leitwerk-dev/ui": "0.4.0",
    "@leitwerk-dev/worker": "0.4.0"
  },
  "devDependencies": {
    "@leitwerk-dev/dev-tools": "0.4.0",
    "typescript": "^6.0.2"
  }
}
```

Save this as `extensions/first-process/package.json`. The build writes the extension’s runtime entry point to `dist/index.js`.

```json
{
  "name": "@example/first-process",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@leitwerk-dev/process-sdk": "0.4.0"
  },
  "leitwerk": {
    "extension": {
      "source": "./src/index.ts",
      "import": "./dist/index.js"
    }
  }
}
```

Save these compiler options as `extensions/first-process/tsconfig.json`.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmitOnError": true,
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

Download [first-process.ts](../examples/first-process.ts) and save it as `extensions/first-process/src/index.ts`.

## Configure the local runtime

Save this as `leitwerk.composition.yaml` in the workspace root. The development command adds the extension in the composition to the ones listed in the runtime configuration.

```yaml
version: 1
runtime_config: ./leitwerk.yaml
extensions:
  - ./extensions/first-process
```

Save this as `leitwerk.yaml` in the workspace root. Choose an OpenAI model ID available to your account.

```yaml
server:
  host: 127.0.0.1
  port: 8080
  base_url: http://127.0.0.1:8080

storage:
  sqlite_path: ./.leitwerk/leitwerk.sqlite
  process_workspaces_dir: ./.leitwerk/workspaces
  tree_files_dir: ./.leitwerk/trees

workers:
  runner: local

pi:
  agent_dir: ./.leitwerk/pi
  default_model_profile: example_model
  model_profiles:
    - id: example_model
      provider: openai
      model_id: gpt-4o

extension_loading:
  sources:
    - "@leitwerk-dev/models"

extensions:
  models:
    openai:
      api_key: env:OPENAI_API_KEY
```

Export `OPENAI_API_KEY` in your shell, then generate a credential encryption key for this workspace.

```sh
mkdir -p .leitwerk
if [ ! -e .leitwerk/credential-key ] && [ ! -e .leitwerk/leitwerk.sqlite ]; then
  (set -C; umask 077; openssl rand -base64 32 > .leitwerk/credential-key)
fi
```

Load the same key into your shell each time you start Leitwerk. If the database exists and the key file is missing, restore its key before starting. Keep `.leitwerk/` out of Git.

```sh
read -r LEITWERK_CREDENTIAL_ENCRYPTION_KEY < .leitwerk/credential-key
export LEITWERK_CREDENTIAL_ENCRYPTION_KEY
npm install
npm run dev
```

Open the UI URL the command prints, usually `http://127.0.0.1:5173`, and [run your process](first-process.md#run-your-process). Stop with `Ctrl+C`. Commit `package-lock.json` and use `npm ci` to reproduce this installation. Use `npm run build` to compile without starting Leitwerk.

## Add workspace checks

To use `leitwerk-dev typecheck`, provide a root TypeScript configuration that includes or references your extension projects. `leitwerk-dev test:full` additionally requires `@biomejs/biome` and `vitest` in the workspace, plus `@playwright/test` if you add a Playwright configuration. Both released and local-core modes support two optional npm hooks.

- `leitwerk:before-test` runs repository-specific checks before the test suite.
- `leitwerk:after-typecheck` runs auxiliary type builds after typechecking.

For packages with typed exports, run `npm exec -- leitwerk-dev api:check --workspace .` to check API classifications and public signature dependencies. See [API compatibility](process-sdk.md#api-compatibility) for `@public` and `@internal` rules.

## Optional local core

Keep an optional core checkout (for example `.leitwerk-base/`) inside the extension repository and switch modes explicitly:

```sh
npm exec -- leitwerk-dev core:use-local --revision <commit-or-tag>
```

First use clones the core revision, installs dependencies, and links one consistent local public package graph. Existing checkouts retain their branch and local edits. Keep mode-selection metadata gitignored and separate from committed manifests and `package-lock.json`. Never mix local SDK packages with registry copies of other `@leitwerk-dev/*` packages.

In local-core mode, launchers resolve Leitwerk and extension code via the `source` export condition, while Pi dependencies continue using published import entries. Subsequent `dev`, `build`, `typecheck`, and `test:full` commands delegate to the linked checkout.

Return to released packages:

```sh
npm exec -- leitwerk-dev core:use-release
```

This restores the committed npm installation without deleting the local checkout. Ordinary `dev`, `build`, and `test` commands never clone, fetch, or switch dependency modes implicitly.

## Reload behavior

- **Standalone released mode (`leitwerk-dev dev`):** Runs in the `dist` runtime lane. On file changes, it rebuilds workspace extensions; build failures keep the running backend up, and successful builds stop and restart the backend with the rebuilt artifacts.
- **Core source mode (`npm run dev` / local core):** Watches TypeScript sources directly. Runtime edits pass an import and Fastify readiness preflight before replacing the backend; a failed preflight leaves the healthy backend running. Configuration or extension-metadata changes restart the session.

Local workers load composed source roots directly. Docker and Kubernetes workers do not read host source paths; package built extension artifacts into worker images for isolated runners.

For core-maintainer compositions, sandboxes, and API reports, see [Development compositions](../maintainers/development-compositions.md).
