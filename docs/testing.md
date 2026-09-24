# Testing

Choose validation by the change and the smallest test boundary that verifies its
behavior. Tests own individual coverage cases; this page owns commands, boundaries,
and harness contracts.

## Validation

| Change | Completion check |
| --- | --- |
| Application code, shared contracts, dependencies, or application build/test/runtime configuration | `npm run test:full`. Focused runs do not replace it. |
| Documentation only, including `AGENTS.md` | Review the diff and consistency; use the documentation checks below when applicable. |
| Standalone helper outside application build/test/runtime paths | Syntax and focused smoke checks. |
| Changes confined to `tools/api-explorer-prototype/` | `npm run check --prefix tools/api-explorer-prototype`, plus browser/visual checks for UI changes. |

The full gate runs lint, build, typechecking, and tests, including browser tests.
Required pre-merge CI checks still apply to every contribution. CI separately runs
`npm run api:check`; the local full gate does not include it.

```sh
npm run test:full
npm run build && npm run api:check
```

Always rebuild before running Vitest directly or through a focused command:

```sh
npm run build
npm run test:unit
npm run test:integration
npm run test:e2e
```

If a failure points into `dist/`, rebuild before debugging logic. Never edit generated
files. Concurrent validation needs separate checkouts or worktrees with independent
dependency installations and build outputs.

To validate an external workspace with core:

```sh
npm run test:full -- --composition=../my-extensions/leitwerk.composition.yaml
```

See [Development compositions](development-composition.md). The full gate reports
phase durations locally and in CI; use them when investigating performance.

## Test boundaries

| Boundary | Use it for |
| --- | --- |
| Unit | Pure rules, reducers, graph validation, and codecs without servers or workers. |
| Package integration | Package contracts across the runtime boundaries they require. |
| Extension | Extension behavior and external-provider adapters. |
| System (`tests/`) | Workflows spanning packages; import through package specifiers. |
| Browser | Layout and behavior that require a browser engine. |

Core packages must not import extensions, including in tests or type imports. Use
synthetic processes for core behavior, `FakeLlmProvider` for model boundaries, and
extension-owned provider fakes. Avoid broad mocks and assertions tied to internal
call sequences or incidental prompt wording.

Test schema migrations against file-backed storage and reopen it to verify durable
data survives. Use generated fixtures, never real provider or repository credentials.

## Extension testing

Choose between two harnesses:

| Harness | Contract |
| --- | --- |
| `createExtensionTestHarness` from `@leitwerk-dev/test-support/process` | Evaluate definitions and handlers without persistence. Each evaluation starts from its supplied fixture; effects do not carry into later calls. |
| `createExtensionIntegrationHarness` from `@leitwerk-dev/test-support/integration` | Execute durable server/worker behavior with registered extensions, fake provider adapters, and scripted model responses. |

### Definition and handler behavior

Supply a process definition, params, optional state, projects, and named markdown
products. Inspect detached descriptions and evaluate launch, action, outcome, or
turn behavior through the harness. Handler evaluation reports requested effects;
it does not commit transitions. Inspect declarative routes in `describe()`.

Tool tests can inspect metadata and external-write receipts, including writes before
a failed invocation. Reuse `invocationId` to exercise retry identity. Provider bindings
belong in project fixture metadata, not handwritten execution contexts. The enclosing
harness owns registration and lifecycle; always await `close()`.

See the [process harness API](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/test-support/src/process.ts)
for supported operations and result types.

### Durable execution

Integration model scripts receive the rendered prompt, declared tools, working
directory, inherited branch text, and opaque branch identity. Execution is automatic
by default. Use `execution: "manual"` when `runTurn()` should release exactly one
selected turn and wait for its durable outcome or failure, including automatic turns.
Acceptance and stale-outcome checks still run through the application.

Use `polling: "manual"` to disable scheduled polling while retaining extension
lifecycle hooks, then invoke the extension-owned polling adapter explicitly. Put
watcher settings in `watchers`; use the `hostDocker` boundary for host preflight.

Process handles expose application actions and detached readonly snapshots.
`waitFor()` is bounded and reports the final observation on timeout. `restart()`
retains file-backed storage and existing process handles; its `whileStopped` callback
can change an external fixture, and `extensionConfig` can replace wiring.
`request()` exercises HTTP without exposing server internals. Await `close()` before
releasing caller-owned fixtures.

See the [integration harness API](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/test-support/src/integration.ts)
for options and observations. Use fixture builders from `@leitwerk-dev/test-support/fixtures`
for independent business data. Use real execution when checking worker tree entries
or resource materialization; seeding accepted records is not execution.

### Harness lifecycle

`createIntegrationHarness()` starts the full `AppContext` lifecycle when binding.
It applies an ephemeral loopback address before reconciliation for unauthenticated
fixtures. Browser fixtures retain their configured UI origin.

| Fixture | Setup |
| --- | --- |
| Normal integration/UI | Default: bind, reconcile, start services, become ready. |
| Controlled startup/reconciliation | `listen: false`, prepare state, then call `ctx.listen(...)`. |
| Bind-only | `backgroundServices: false`; readiness remains false. Recreate for full startup. |
| Injection-only | `listen: false`; start a listener before launching local workers. |
| Deployment preflight | Raw Fastify listener, no background services; readiness stays false. |

Always await `close()` and release caller-owned directories/compositions in `finally`,
including startup failure. See [AppContext](server-worker-lifecycle.md#appcontext-lifecycle)
for listener options, ownership, concurrency, and failure semantics.

## Browser testing

Install engines once, then build before running:

```sh
npx playwright install chromium firefox webkit
npm run build
npm run test:browser
```

On Linux, add `--with-deps` to browser installation for system libraries. The full gate
runs all three engines. After building, a focused run may select one:

```sh
LEITWERK_BROWSER_ENGINE=firefox npx playwright test
```

Firefox is the visual reference; compare identical viewport sizes. WebKit covers
Safari's rendering engine, not native browser chrome or OS menus. Playwright does
not support Firefox mobile emulation or wheel input in mobile WebKit.

Each run gets its own UI server and prints an artifact directory under `test-results/`.
Preserve traces and retry artifacts from concurrent runs. For manual source UI work,
use `npm run dev:sandbox`; see the
[sandbox guide](https://github.com/leitwerk-dev/leitwerk/blob/main/sandbox/README.md).

## Documentation

Follow [WRITING.md](https://github.com/leitwerk-dev/leitwerk/blob/main/WRITING.md).
Keep a contract in its owning page and link to it from walkthroughs. Optional
extensions document their own behavior. Describe current contracts and operator
tasks; do not turn reference pages into change logs.

```sh
python3 -m pip install -r requirements-docs.txt
npm run docs:build
npm run docs:serve
```

Check the rendered navigation, code, tables, and diagrams after structural changes.
Strict site builds check local page links and anchors. They do not execute shell
commands or establish that an installation works.

The standalone example check compiles the tutorial, validates its graph and launcher,
and checks local, Docker, and Kubernetes configuration with the current schema:

```sh
npm run build
node --import tsx scripts/check-doc-examples.mjs
```

It does not call a model, start workers, or deploy containers. The Docker example
also needs a focused `docker compose config --quiet` check using temporary placeholder
secrets. A real deployment smoke check is separate and must use disposable storage.

## Failure diagnosis

Keep a separate log per run for intermittent failures. Compare the last started stage,
subprocess exits, and shutdown timestamps. A passing rerun does not disprove an
ordering bug or leak.

```sh
bash scripts/collect-test-failures.sh --max-runs 50 --log-dir /tmp/leitwerk-failures
```

The collector repeats the full gate until ten failures or the run limit. Without a
limit it runs until ten failures or interruption. It writes full logs, excerpts, and
`summary.tsv` to a fresh directory, but does not archive browser artifacts. Timeout
classifications are hints, not diagnoses.

Exit 0 means ten failures were collected, not validation passed. Exit 1 means the
run limit came first; exit 2 means invalid arguments or setup failure. Interrupted
runs do not count toward failures.

## Opt-in checks

Live Docker-runtime checks require infrastructure and run outside the full gate.
See the [runtime guide](https://github.com/leitwerk-dev/leitwerk/blob/main/scripts/docker-runtime/README.md).

Worker startup benchmarks also require a real model or cluster. After building, run
`npm run benchmark:worker-startup -- --help`; see the
[benchmark reference](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/dev-tools/README.md#worker-startup-benchmark).
