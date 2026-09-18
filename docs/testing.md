# Testing

## Validation

A change is complete when `npm run test:full` passes. This gate runs lint, build,
typechecking, and tests, including browser tests. Focused runs help diagnose
failures but do not replace the full gate.

```sh
npm run test:full
```

Always rebuild before running Vitest directly or through a focused test command:

```sh
npm run build
npm run test:unit
npm run test:integration
npm run test:e2e
```

If a failure points into `dist/`, rebuild before debugging the implementation.
Never edit generated files by hand.

CI runs `npm run api:check` separately after the full gate; local `test:full`
does not include it. To check locally, run `npm run build && npm run api:check`.
It checks release tags and signature dependencies and verifies that public and
internal declarations survive the build.

### Harness lifecycle compatibility

For the next minor release, `createIntegrationHarness()` and the internal `createTestApp()`
start the full `AppContext` lifecycle by default whenever they bind a listener. Their returned
address is applied before reconciliation for ephemeral unauthenticated loopback fixtures.
Use `await harness.close()` (or the test app's `close()`) for cleanup. Caller-owned temporary
directories and compositions still belong in `finally` blocks, including startup failures.

| Use | Options / behavior |
|---|---|
| Normal integration or UI fixture | Default: bind, reconcile, start services, become ready. |
| Controlled restart or reconciliation test | `createIntegrationHarness({ listen: false, ... })`: prepare state, then call `ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true })`. The harness address becomes available after startup. |
| Bind-only fixture | `backgroundServices: false`: raw listener, no reconciliation or background services. Close and recreate the context to use full startup. |
| Injection-only fixture with no listener requested | `createIntegrationHarness({ listen: false, ... })` stays unbound with no background startup. Start the listener before launching local workers. |
| Browser fixture | Full lifecycle; preserve the configured UI origin. |
| Deployment preflight | Raw Fastify listener only; assert readiness remains false; clean up with `ctx.close()`. |

Lifecycle tests exercise real HTTP/WebSocket draining, concurrent startup/shutdown,
startup and cleanup failures, database ownership, and durable state across recreation.

### Browser layout and behavior

To validate external packages, extensions, and test roots in a development
composition:

```sh
npm run test:full -- --composition=../private/leitwerk.composition.yaml
```

See [Development Compositions](development-composition.md).

Concurrent full validations require separate checkouts or worktrees, each with
its own dependency installation. Do not share `node_modules` or rebuild outputs
that another run is testing.

The full gate reports phase durations, also available in the GitHub Actions job
summary. Use these measurements when investigating validation performance.

## Test boundaries

Use the smallest test boundary that can verify the behavior:

- Unit tests exercise pure rules, reducers, graph validation, and codecs without
  starting servers or workers.
- Package integration tests exercise package contracts with the required runtime
  boundaries. Use synthetic processes for core runtime behavior.
- Extension tests own extension behavior and integrations with external providers.
- System tests under `tests/` exercise workflows across packages. Import through
  package specifiers, such as `@leitwerk-dev/domain`.
- Browser tests verify behavior and layout that depend on a browser.

Core packages must not import extensions, including in tests or type imports.
Use `FakeLlmProvider` and extension-owned fakes at external boundaries instead of
broad mocks. Assert observable behavior; avoid assertions tied to prompt wording
or internal call sequences.

Test schema migrations against file-backed storage. Verify that durable data
survives migration and reopening. Use generated fixtures, never real provider or
repository credentials.

## Browser testing

Install browser engines once:

```sh
npx playwright install chromium firefox webkit
```

On Linux, add `--with-deps` to install required system libraries. Rebuild before
running the browser suite:

```sh
npm run build
npm run test:browser
```

The full gate runs Chromium, Firefox, and WebKit. To select one engine for a
focused run, including tests from the active composition:

```sh
LEITWERK_BROWSER_ENGINE=firefox npx playwright test
```

Firefox is the visual reference. Compare layouts at matching viewport sizes.
WebKit exercises Safari's rendering engine; screenshots do not cover native
browser chrome or operating-system menus. Playwright does not support Firefox
mobile emulation or wheel input in mobile WebKit.

Each browser run starts its own UI server on a free port.
`npm run test:browser` prints its artifact directory under `test-results/`.
Concurrent runs must preserve each other's traces and retry artifacts.

For manual source UI verification, run `npm run dev:sandbox`. See the
[sandbox guide](https://github.com/leitwerk-dev/leitwerk/blob/main/sandbox/README.md).

## Failure diagnosis

For intermittent failures, retain a separate log for each run. Compare the last
started stage with subprocess exits and cleanup timestamps. A passing rerun does
not rule out an ordering bug or resource leak.

To collect repeated failures:

```sh
bash scripts/collect-test-failures.sh --max-runs 50 --log-dir /tmp/leitwerk-failures
```

The collector repeats the full gate until ten runs fail or the run limit is
reached. Without `--max-runs`, it runs until ten failures are collected or it is
interrupted. It saves complete logs, timeout excerpts, and `summary.tsv` in a
fresh directory. Browser artifacts are not archived. Timeout classifications
are triage hints, not diagnoses.

Exit status 0 means ten failures were collected, not that validation passed.
Status 1 means the run limit was reached first; status 2 indicates invalid
arguments or directory setup failure. Interrupted runs stop the collector and
do not count toward the failure total.

## Opt-in checks

Live Docker-runtime checks require local or cluster infrastructure and run
outside the full gate. See the
[Docker-runtime guide](https://github.com/leitwerk-dev/leitwerk/blob/main/scripts/docker-runtime/README.md)
for local Docker, Docker-host, Sysbox, and Kubernetes commands.

Worker startup benchmarks against a real model or cluster are also opt-in.
After building, run `npm run benchmark:worker-startup -- --help`. See the
[benchmark command](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/dev-tools/README.md#worker-startup-benchmark)
for configuration and reports.
