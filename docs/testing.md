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

The full gate reports the duration of every validation phase. In GitHub Actions it also
writes the timing table to the job summary. Use those measurements before parallelizing or
removing a validation phase.

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
- **Avoid Change Detector Tests:** Tests verify business behavior, not implementation details. For example, prompt tests assert runtime variable interpolation and sentinel values—never literal prompt prose—so harmless text edits don't break tests.

---

## 2. Test Layers

- **Pure Unit Tests:** Test domain rules, state reducers, graph validation, and codecs without booting Fastify servers or workers. Test startup interpretation at the pure `startup-evidence` projector seam. Keep launch-pipeline tests focused on adapter sequencing, preparation-check insertion, active-step failures, and commit semantics rather than retesting worker evidence. HTTP integration setup must admit immediate launches through `/launch-runs` and observe the durable run; `postImmediateLaunch` in test support provides that setup without restoring a blocking production route.
- **Package Integration Tests:** Test package host behavior using synthetic processes and fakes.
- **Extension Tests:** Test extension catalog registration, custom turns, watchers, outcome tools, and external provider integrations.
- **Server & Worker System Tests:** Boot Fastify with in-memory SQLite and fake boundaries to test `ProcessEngine` lock coordination, WebSocket IPC streaming, turn correlation, and error recovery.
- **Session Transfer Tests:** Cover grant expiry and hashing, one-active-attempt exclusion, quiescent snapshot ordering, lease/deadline cancellation, restart reconciliation, archive limits and unsafe paths, stream digest acknowledgement, atomic local import recovery, and Svelte link/cancellation states. Archive tests must use generated fixtures and never real provider or repository credentials.

## Lazy reasoning history

Structural performance tests compare short and long current turns with fresh and reused readers. Assert bounded summary bytes and indexed records read; inspect SQLite query plans to catch scans hidden by small result sets. Forbid full event-history queries and session parsing in initial page handling. File-backed migration tests preserve events and process state, verify equal-timestamp ingestion order, and reopen storage to verify persisted summaries.

Recovery tests cover more than the former event-window limits, multiple LLM calls, tool results, operational events, duplicate frames, delayed responses, and completion during reconnect. Browser tests verify that details are requested only on expansion, a delayed detail request leaves controls usable, and desktop/mobile previews show four wrapped nonblank lines with stable dimensions and outer scrolling. Rebuild before Vitest and run `npm run test:full` before completion.
