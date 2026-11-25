# Testing

Choose the smallest validation boundary that verifies the change; `npm run test:full` is required before completing any application, shared contract, dependency, or build/test/runtime change. For extension test harnesses, see [Extension testing](../extensions/testing.md).

## Validation matrix

| Change scope | Required local check |
| --- | --- |
| Application code, shared contracts, dependencies, or build/test/runtime config | `npm run test:full` (plus `npm run build && npm run api:check` for API surface parity with CI) |
| Documentation only (including `AGENTS.md`) | Review diff and run `npm run docs:build` (plus `scripts/check-doc-examples.mjs` when examples change) |
| Standalone helper outside build/test/runtime paths | Syntax check and focused smoke check |
| Confined to `tools/api-explorer-prototype/` | `npm run check --prefix tools/api-explorer-prototype` and browser visual checks |
| Confined to `tools/workflow-graph-prototype/` | `npm run check --prefix tools/workflow-graph-prototype` and browser visual checks |

`npm run test:full` executes 13 phases in order: `lint`, `parity:build`, `test:server-start`, `test:default-worker`, `check:boundaries`, `release:check`, `typecheck`, `test:parity:built`, `test:unit`, `test:integration`, `test:e2e:process`, `test:ui-integration`, and `test:browser`. Validate a sibling workspace together with core via:

```sh
npm run test:full -- --composition=../my-extensions/leitwerk.composition.yaml
```

## Source aliases vs. built artifacts

- **Vitest runs against live sources:** `vitest.config.ts` aliases all workspace packages to source via `buildWorkspaceSourceAliases` across seven projects (`unit`, `unit-isolated`, `unit-forks`, `integration`, `integration-isolated`, `e2e`, `ui-integration`). Focused Vitest commands (`npm run test:unit`, `test:integration`, `test:e2e`) do not consume stale `dist/` artifacts.
- **Built-artifact suites require `build` / `parity:build`:** `npm run test:parity*`, `npm run test:browser` (serves `packages/ui` via Vite preview), `npm run api:check` (checks built `dist/` outputs), and `scripts/check-doc-examples.mjs` execute compiled outputs. Always run `npm run build` (or `npm run parity:build`) before debugging failures in `dist/` or running Playwright.

Never edit `dist/` by hand. Run concurrent validations in separate checkouts or worktrees so builds and caches do not collide.

## Test and boundary rules

| Boundary | Scope |
| --- | --- |
| Unit | Pure domain rules, reducers, graph validation, and codecs. |
| Package integration | Package contracts across the runtime boundaries they require. |
| Extension | Extension behavior and provider adapters using extension test harnesses. |
| System (`tests/`) | Multi-package workflows importing through `@leitwerk-dev/*` specifiers. |
| Browser (`tests/browser/`) | Layout and end-to-end UI interactions across Chromium, Firefox, and WebKit. |

`npm run check:boundaries` (`scripts/check-boundaries.mjs`) enforces:

- Core `packages/*` never depend on or import `extensions/*` (including tests, types, and extension-specific integration names).
- Server production code and dependencies never import `@leitwerk-dev/worker`; `process-model-policy` is imported only through its barrel.
- Worker production entrypoints exclude test helpers and stub Pi hooks; `worker/src/runtime` internals remain private.
- Extension UI modules only import relative files or `@leitwerk-dev/process-sdk/leaf-outcome-renderer`, and built UI bundles contain no unresolved bare specifiers.
- Server and top-level tests author processes with `defineProcess` / `flow` instead of raw `transitions:` fixtures.

Use synthetic processes for core tests, `FakeLlmProvider` for model boundaries, and extension-owned fakes for external providers. Test SQLite migrations against file-backed storage and reopen the database to verify durable data survives.

### Harness lifecycle

`createIntegrationHarness()` starts the full `AppContext` lifecycle when binding, assigning an ephemeral loopback address before reconciliation for unauthenticated fixtures (browser fixtures retain their configured UI origin):

| Fixture | Setup |
| --- | --- |
| Normal integration/UI | Default: bind, reconcile, start services, become ready. |
| Controlled startup/reconciliation | `listen: false`, prepare state, then call `ctx.listen(...)`. |
| Bind-only | `backgroundServices: false`; readiness stays false. Recreate for full startup. |
| Injection-only | `listen: false`; start a listener before launching local workers. |
| Deployment preflight | Raw Fastify listener without background services; readiness stays false. |

Always await `close()` and release caller-owned directories or compositions in `finally`, including on startup failure; see [AppContext lifecycle](server-worker-lifecycle.md#appcontext-lifecycle).

## Browser tests

```sh
npx playwright install chromium firefox webkit   # add --with-deps on Linux
npm run build
npm run test:browser
```

`test:browser` runs all three engines concurrently—two shards per engine on hosts with at least four available CPUs, or one shard per engine on smaller hosts—writing per-shard artifacts under `test-results/`. Run a single engine after building with `LEITWERK_BROWSER_ENGINE=firefox npx playwright test`. Firefox is the visual reference for layout comparisons.

## Documentation checks

```sh
python3 -m pip install -r requirements-docs.txt
npm run docs:build
npm run docs:serve
```

`npm run docs:build` runs staging/link unit tests (`scripts/build_docs_test.py`) and builds the site with Zensical strict link and anchor validation (`scripts/build_docs.py build`). The build also generates the LikeC4 web component bundle from `docs/maintainers/likec4/` with the `likec4` devDependency, so run `npm ci` first.

Embed a LikeC4 view in any page with a fence that holds only the view id:

````md
```likec4-view
containers
```
````

An id that is not declared in `docs/maintainers/likec4/` fails `docs:build`.

After building workspace packages, validate tutorial compilation and config examples with:

```sh
npm run build
node --import tsx scripts/check-doc-examples.mjs
```

For Docker Compose examples, also run `docker compose config --quiet` with temporary placeholder environment values.

## Failure diagnosis and opt-in checks

- **Intermittent failures:** `bash scripts/collect-test-failures.sh --max-runs 50 --log-dir /tmp/leitwerk-failures` repeats `test:full` and collects logs/excerpts (exits 0 when 10 failures occur, 1 on run limit, 2 on bad arguments).
- **Live Docker/Kubernetes runtime canaries:** `scripts/docker-runtime/README.md`.
- **Worker startup benchmark:** `npm run benchmark:worker-startup -- --help` (`packages/dev-tools/README.md`).
