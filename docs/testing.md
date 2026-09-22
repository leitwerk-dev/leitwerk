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

For the next minor release, `createIntegrationHarness()` starts the full `AppContext`
lifecycle by default whenever it binds a listener. Its returned address is applied before
reconciliation for ephemeral unauthenticated loopback fixtures.
Use `await harness.close()` for cleanup. Caller-owned temporary
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

## Extension testing

Use `createExtensionTestHarness` from `@leitwerk-dev/test-support/process` to
inspect process descriptions and evaluate behavior without persistence. Supply a
process definition, params, optional state, projects, and named markdown products.
Each evaluation starts from that fixture; effects do not carry into later calls.

`describe()` returns detached descriptions. `resolveLaunch()`, `prepareRelaunch()`,
and `resolveWatcherLaunch()` evaluate launch behavior. `evaluateTurn()` runs
preparation and the worker handler with scripted outcomes, recording prompts,
tools, progress, completion, and parking. `evaluateAction()` and
`evaluateOutcome()` report effects requested by handlers. Declarative transitions
remain available through `describe()`; evaluating an outcome does not persist or
apply them. The enclosing harness owns extension registration and lifecycle hooks
and provides `callTool()`, `emit()`, and `close()`. `describeTools()` returns
tool metadata; `writeReceipts()` returns recorded external writes, including
writes preceding a failed invocation. Reuse a tool fixture's `invocationId` to
test retries. Provider project bindings belong in project fixture metadata.
`listToolDestinations()`, `resolveToolDestination()`, and
`validateToolDestination()` exercise registered ticket destinations.

Use `createExtensionIntegrationHarness` from
`@leitwerk-dev/test-support/integration` for durable server and worker behavior.
Register extensions and provider adapters, configure model profiles, and supply
model tool scripts. Scripts receive the rendered prompt, declared tool descriptions,
working directory, inherited branch text, and an opaque branch identity.
Execution is automatic by default. `polling: "manual"` disables scheduled provider
polling while preserving extension lifecycle hooks; call an extension-owned
polling adapter explicitly. Watcher configuration belongs in `watchers`; host
Docker preflight can use the `hostDocker` boundary. With `execution: "manual"`,
`runTurn()` releases exactly one selected worker turn and waits for its durable
outcome or failure. This includes automatic turns. Worker acceptance and stale
outcome correlation still run through the application.

Process handles expose application actions, retry, instruction delivery, question
answers, and approval responses. `snapshot()` returns detached readonly process data, execution records, inputs,
interactions, receipts, semantic events, annotations, rendered leaf results, and
the workspace path;
`waitFor()` has a bounded timeout and includes the final observation on failure.
`request()` supports HTTP status and response assertions without exposing the
server context. `restart()` retains file-backed storage and existing process
handles. Its optional `whileStopped` callback can change an external fixture before
reopening, and `extensionConfig` can replace extension wiring. `processes()`
observes processes created by watchers. Always await `close()` to release resources and remove harness files.

Use `createProcessFixture`, `createProjectFixture`, `createQuestionFixture`, and
`createQuestionRequestFixture` from `@leitwerk-dev/test-support/fixtures` for
independent deterministic data. Definition-aware process fixtures validate params,
state, and declared turns. Question resolutions determine status and timestamps.
Fixtures accept business data, not worker leases or execution pointers.

`seedAcceptedTurn()` creates correlated accepted execution records. A running
fixture must match the selected turn. A successful historical fixture preserves
business position and returns a turn-result artifact reference. Both reject live
execution conflicts. Use real execution when assertions depend on worker tree
entries or runtime resource materialization.

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
Vite uses a separate optimized-dependency cache for each browser engine, or the
explicit `LEITWERK_BROWSER_VITE_CACHE_DIR` when one is supplied.

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
