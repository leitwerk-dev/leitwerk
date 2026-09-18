# Testing Directives & Test Harnesses

This guide explains how to test code across the Leitwerk monorepo. Read this document to understand test layer boundaries, Vitest setup, using fakes over broad mocks, and running the mandatory completion gate (`npm run test:full`).

---

## 1. Core Principles & Verification Commands

### Verification Commands

```bash
# Run full monorepo build, lint, typecheck, and test suite (mandatory gate)
npm run test:full

# Layered Vitest projects (rebuild first if dist/ may be stale)
npm run test:unit
npm run test:integration
npm run test:e2e

# Rebuild packages if tests fail in dist/ due to stale build artifacts
npm run build
```

### Browser layout and behavior

Install the browser engines once with `npx playwright install chromium firefox webkit`
(`--with-deps` also installs system libraries on Linux). After rebuilding, run
`npm run test:browser`. The full gate includes this suite in Chromium (Chrome),
Firefox, and WebKit (Safari), including composed browser tests. Use
`-- --project=firefox` to select one engine. Each run selects free loopback API
and UI ports and passes them to its workers and Vite proxy; it never reuses an
existing UI server. `LEITWERK_BROWSER_API_PORT` and `LEITWERK_BROWSER_UI_PORT`
carry these ports within the run.

Firefox is the visual reference. At matching viewport sizes, verify shared page
layouts and form controls, including the waiting-process composer while the
chronicle is scrolled to the top. Browser layout tests assert control dimensions,
viewport containment, and draft preservation and attach screenshots for review.
The route-scroll tests use touch gestures in Chromium and wheel gestures in the
other engines using narrow desktop viewports. Playwright does not support mobile
emulation in Firefox or wheel input in mobile WebKit. WebKit exercises Safari's rendering engine;
native browser chrome and operating-system menus are outside these screenshots.

The full gate reports the duration of every validation phase. In GitHub Actions it also
writes the timing table to the job summary. Use those measurements before parallelizing or
removing a validation phase. Typechecking emits declarations only, preserving the JavaScript
bundles produced by the build. Integration tests launch the bundled session exporter CLI as a
child process to verify startup and failure exits; importing the helper library must not start
an export.

A development composition applies the same gate to its external packages, extensions, and test roots:

```bash
npm run test:full -- --composition=../private/leitwerk.composition.yaml
```

See [Development Compositions](development-composition.md).

Live Docker-runtime checks are opt-in because they require mutable local or cluster
infrastructure. See `scripts/docker-runtime/README.md` for the disposable local-context,
Docker-host, Sysbox, and Kubernetes commands. The isolated image and infrastructure canaries
build and run a nested image, replace the outer container or Pod, and verify retained reuse with
`--pull=never`. Blocking tests cover the trusted entrypoint and runner contracts; the live
canaries do not replace `test:full`.

In-process workflow fixtures for Docker-declaring processes can inject
`AppOptions.localWorkerDockerPreflightImpl`. This replaces only `docker info` at
admission and local worker startup; the fixture must still set
`local_worker.allow_host_docker: true`. Production uses the real preflight when
the injection is omitted.

Leitwerk's build entry points and hosted workflows opt out of anonymous tooling usage
reporting. Turborepo telemetry and update checks are disabled explicitly, while
`DO_NOT_TRACK` and `SCARF_ANALYTICS=false` cover tools and dependency install hooks that
honor those conventions. Keep these settings intact when adding a workflow or another
Turborepo entry point.

### Core Principles

- **Functional Core, Imperative Shell:** Pure domain logic, graph routing, and codecs are isolated from side effects. This makes them fast and simple to unit test without booting Fastify servers or physical workers. Imperative boundaries use deterministic fakes (`FakeLlmProvider` and extension-owned fakes) rather than broad mocks.
- **Shared fixtures:** System and browser tests use `tests/helpers/accepted-llm-turn.ts` to create accepted starts, leases, and turn records together.
- **Browser isolation:** Each Playwright invocation selects ephemeral API and UI ports, inherited by its workers through `LEITWERK_BROWSER_API_PORT` and `LEITWERK_BROWSER_UI_PORT`. It starts its own UI server and never reuses another run's server. The full gate assigns sibling output directories under `test-results/` to Chromium, WebKit, concurrent Firefox, and serial Firefox layout runs. No invocation may clean another invocation's traces or retry artifacts.
- **Avoid Change Detector Tests:** Tests verify business behavior, not implementation details. For example, prompt tests assert runtime variable interpolation and sentinel values—never literal prompt prose—so harmless text edits don't break tests.

---

## 2. Test Layers

- **Pure Unit Tests:** Test domain rules, state reducers, graph validation, and codecs without booting Fastify servers or workers. Test startup interpretation at the pure `startup-evidence` projector seam. Keep launch-pipeline tests focused on adapter sequencing, preparation-check insertion, active-step failures, and commit semantics rather than retesting worker evidence. HTTP integration setup must admit immediate launches through `/launch-runs` and observe the durable run; `postImmediateLaunch` in test support provides that setup without restoring a blocking production route.
- **Package Integration Tests:** Test package host behavior using synthetic processes and fakes. Real-Git rebase scenarios also run here, with a suite-local 60-second budget for their many subprocesses; ordinary unit-test timeouts remain unchanged.
- **Extension Tests:** Test extension catalog registration, custom turns, watchers, outcome tools, and external provider integrations.
- **Server & Worker System Tests:** Boot Fastify with in-memory SQLite and fake boundaries to test `ProcessEngine` lock coordination, WebSocket IPC streaming, turn correlation, and error recovery.
- **Session Transfer Tests:** Cover grant expiry and hashing, one-active-attempt exclusion, quiescent snapshot ordering, lease/deadline cancellation, restart reconciliation, archive limits and unsafe paths, stream digest acknowledgement, atomic local import recovery, and Svelte link/cancellation states. Archive tests must use generated fixtures and never real provider or repository credentials.

## Lazy reasoning history

Structural performance tests compare short and long current turns with fresh and reused readers. Assert bounded summary bytes and indexed records read; inspect SQLite query plans to catch scans hidden by small result sets. Forbid full event-history queries and session parsing in initial page handling. File-backed migration tests preserve events and process state, verify equal-timestamp ingestion order, and reopen storage to verify persisted summaries.

Recovery tests cover more than the former event-window limits, multiple LLM calls, tool results, operational events, duplicate frames, delayed responses, and completion during reconnect. Browser tests verify that details are requested only on expansion, a delayed detail request leaves controls usable, and desktop/mobile previews show four wrapped nonblank lines with stable dimensions and outer scrolling. Rebuild before Vitest and run `npm run test:full` before completion.

### Stateful scripted Pi

`StubPiTreeHandleFactory` accepts asynchronous script resolvers. Each invocation
includes its instance ID, workspace and session directory, tree file and persisted
turn sequence. A script may emit text chunks with a controlled delay before
executing tool calls. Calls receive their stable tool-call ID, abort signal and
prompt-guard suspension hook. Aborting or closing the handle cancels delayed
streams and interactive tools. Scripted behavior can therefore depend on execution
context and tool contracts without matching prompt prose.

An optional `afterToolResult(call, result)` callback can return a follow-up call
in the same scripted turn. Use it to respond to actual tool feedback, such as
revising a ticket draft after operator feedback. Follow-up calls use the same
abort and trace handling as the initial calls.

Set `recordSessionTrace: true` to persist SDK-readable session JSONL, including
scripted `thinkingChunks`, text, and executed tool calls/results. Thinking and text
emit distinct stream types. Input and partial output are saved before interactive
tools or failed turns finish. Fresh factories can resume these sessions and older
stub state files without discarding entries. The option keeps additional trace
entries out of tests that depend on the minimal stub tree.

`createInProcessWorkerSpawn` accepts an optional `startupDelays(instanceId)` resolver
for development scenes. It delays connection and managed Pi bootstrap without
replacing lifecycle observations. Delays are canceled when the child exits or is
killed; callers without a resolver retain immediate startup.

### Shared development sandbox

Use `@leitwerk-dev/dev-sandbox` for application startup and cleanup with an explicit
composition. Its package tests use synthetic catalogs to preserve core/extension
boundaries. Built-in notebook scenarios live in `sandbox/`. Sandbox supervisor,
control, and receipt tests live in `sandbox/tests/` and run once in the
`integration-isolated` Vitest project, preserving per-file module isolation.
Product workflows remain in `tests/e2e/sandbox/`; both layers share fixtures in
`sandbox/testing/`. The sandbox TypeScript project includes its source CLI,
integration tests, shared fixtures, and remaining E2Es in the full gate.
`createProcessDriver` from `@leitwerk-dev/test-support/integration` shares HTTP actions and process waits; its context callback follows app restarts.
`createPollingTestExtension` from `@leitwerk-dev/test-support` wraps provider setup as an extension with a typed `poll()` method for fixtures and sandbox compositions.

Run `npm run dev:sandbox` for source UI verification. The public composition uses
real local Git history and normal process finalization. It retains Pi traces and
adapter progress across restarts. Local adapters share versioned persistence, clocks, and id
allocation through `LocalProviderStore` from `@leitwerk-dev/test-support/local-git`.
`LocalForgeStore` adds shared repository metadata, PR construction, refresh, merge, feedback, and a `pullRequestClient` for reading, listing, and updating PRs.
Launcher tests start the public supervisor with
an isolated workspace and environment, check strict ports, exercise the outer
configuration reload, and verify acknowledged reset. Preflight tests prove that
application and adapter initialization use disposable storage. See the
[sandbox guide](https://github.com/leitwerk-dev/leitwerk/blob/main/sandbox/README.md).

## Startup E2E replacement ledger

Server-owned replacements live in
`packages/server/src/startup-reconciliation.integration.test.ts`. They use a
synthetic process, real worker runtime over WebSocket with an in-process spawn
adapter, HTTP snapshots/abort, and file-backed SQLite. Pi is scripted; these are
not physical-worker or abrupt-crash tests.

| Removed assertion from `workflows.e2e.test.ts` | Replacement assertion | Removal condition |
| --- | --- | --- |
| `startup` and `startup-cold` reach pre-connection progress, abort without turn records, and report `superseded` | Parameterized cancellation test retains both connection delays, observes startup progress, proves a reserved start exists without an accepted turn, awaits HTTP abort, and checks durable abort plus zero turn records after reopening storage | Both parameter rows pass |
| Delayed startup succeeds with every observation step completed; restart preserves attempts | Successful delayed-start test crosses connection and preparation delays, completes a synthetic LLM turn, checks accepted start and completed observation steps, and reopens SQLite in a fresh app to compare attempts and records | Persistence replacement passes |
| Startup scenario control request returns 202 | Sandbox `controls.integration.test.ts` covers control admission; startup-specific scene timing is no longer a product E2E assertion | Control tests remain in the full gate |

The retained repository happy-path E2E covers arrival at the ordinary planning
decision. The startup test instead completes a synthetic process to isolate
runtime acceptance and persistence from repository policy. Short successful
startup delays are sufficient to cross both asynchronous boundaries; cancellation
retains the two original delay values.

## Session and question E2E replacement ledger

`packages/server/src/scripted-session.integration.test.ts` uses a synthetic LLM
process, real worker runtime over WebSocket, HTTP, generated Pi JSONL, and
file-backed SQLite reopened with a fresh app and Pi factory. Git and production
repository processes are not required. These are graceful-restart tests, not
abrupt-crash coverage.

| Removed assertion from `workflows.e2e.test.ts` | Replacement assertion | Removal condition |
| --- | --- | --- |
| Scripted failure parks planning, reasoning exposes the original prompt, HTTP retry reaches the next decision, scenario step is two | Failed-worker retry test checks selected turn retention, failed-record input via reasoning HTTP, exactly two scripted calls, one failed and one succeeded record, and retained records/input after restart | Retry replacement passes |
| Long result exceeds 20,000 characters | Streamed-output test persists a generated result exceeding 20,000 characters in the turn record | Session replacement passes |
| Session HTTP contains observation 80 and thinking; restart returns identical content | Streamed-output test emits 80 delayed text frames and distinct thinking, checks session HTTP and exact response/record retention after reopening storage | Session replacement passes |
| Ordinary question API answers first option and unblocks planning | Worker-question test posts the generated option ID through HTTP, checks the actual tool result and completion on the same accepted turn record; route tests separately cover attribution and duplicate rejection | Question replacement passes |
| Three accepted reviews enter planning pass four at revision three, then return to the planning decision | Extension-owned `worker-tree.integration.test.ts` executes three review/action/plan cycles; see its README ledger | Review replacement passes |

The sandbox's choice to ask a question specifically on pass four is scripted scene
content, not production routing policy. Question transport and review routing are
now tested independently. The retained local repository E2E proves the ordinary
planning and implementation decisions remain connected to real Git finalization.

## Intermittent timeout diagnostics

The feedback-routing integration cases and GitHub tool reconciliation test use
`createTestDiagnostics` from `@leitwerk-dev/test-support/local-git`. Each trace
records UTC timestamps, monotonic elapsed time, worker-thread identity, and named
workflow stages, including cleanup. `trace.run()` scopes LocalGit subprocess
start/exit events to that test across async calls. Exits include duration, status,
signal, and error code; arguments, environment, and subprocess output are omitted.
The trace retains the latest 512 events and reports how many were dropped.
`onTestFailed` prints it on failure; successful tests remain quiet. This is
in-memory diagnostics, not a durable crash recorder: process termination can lose
it, and work continuing after the failure report is not included.

Forgejo remote-change and terminal-reconciliation tests also use the diagnosed
extension fixture. Its trace starts before Git/app setup and scopes every awaited
fixture operation, including restart and cleanup. A 250-ms sampler records only
changed process/turn/start states, active lease identities, armed source kinds and
scripted turn kinds. Sampling stops before cleanup; the last snapshot remains in
the trace after SQLite closes. Worker spawn, kill, exit and sanitized connection
observations carry instance/worker IDs and app generation, so reconnects can be
correlated with the server that closed. The worker's optional connection observer
preserves its normal diagnostic recorder; it does not capture raw stderr, tokens,
prompts or provider payloads. Timers and traces do not extend test budgets.

The Docker canary separately captures its shell subprocess error and signal,
including `ETIMEDOUT`, rather than reporting only a null exit status. Its fake
kubectl records starts and exits; failure output includes recent and unmatched
commands plus shell output before temporary files are removed. The subprocess
budget includes both replacement generations; timeout terminates the owned
process group before storage cleanup. These are fixture commands and manifests,
not operator data.

For a suspected hang, preserve each run in a distinct log and compare the last
started stage with subprocess exits and cleanup timestamps. Rebuild first. Run
Vitest projects separately when their worker limits differ. A passing rerun does
not rule out ordering bugs or leaks; reconnect messages alone do not establish
whether IPC failed before or during teardown. Diagnostics alone do not extend test budgets.

### Collect repeated failures

```sh
bash scripts/collect-test-failures.sh
# Optional total-run cap and log parent directory:
bash scripts/collect-test-failures.sh --max-runs 50 --log-dir /tmp/leitwerk-failures
```

The script repeats `npm run test:full` sequentially until **10 runs fail**.
Passing runs do not count; timeout and non-timeout failures both count. Each
invocation creates a fresh log directory containing complete per-run output,
timeout-match excerpts, and `summary.tsv` with timestamps, durations, exit codes,
and classifications. A failed full gate stops at its first failing phase, as
usual. Timeout classification uses diagnostic text and is a triage hint, not a
root-cause determination. Browser artifacts are not archived by this script.

Exit status is 0 after collecting ten failed runs, 1 when the optional total-run
limit is reached first, and 2 for invalid arguments or initial directory setup
failure. Interrupted runs stop the loop and do not count. The default has no run
limit; use Ctrl-C to stop it. Each full-gate invocation includes the required
build before Vitest. Do not treat this collector's successful exit as passing
validation: it means ten failures were collected.

## Worker startup benchmarks

`@leitwerk-dev/dev-tools` provides a repeatable API benchmark with retained launch
identities, raw startup observations and coverage-aware median/p90 reports. After
building this checkout, use `npm run benchmark:worker-startup -- --help`, or invoke
`leitwerk-dev benchmark:worker-startup` from an installed development-tools package.
The launcher, model profile, input, candidate label and new output directory are
explicit. Kubernetes provenance is optional. See the [benchmark command](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/dev-tools/README.md#worker-startup-benchmark).

Normal tests use a local HTTP server to cover response loss, idempotent launch
retries, interruption, timeouts and raw evidence. Running the benchmark against a
real model or cluster is opt-in and is outside `test:full`.
