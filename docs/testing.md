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

- **Pure Unit Tests:** Test domain rules, state reducers, graph validation, and codecs without booting Fastify servers or workers.
- **Package Integration Tests:** Test package host behavior using synthetic processes and fakes.
- **Extension Tests:** Test extension catalog registration, custom turns, watchers, outcome tools, and external provider integrations.
- **Server & Worker System Tests:** Boot Fastify with in-memory SQLite and fake boundaries to test `ProcessEngine` lock coordination, WebSocket IPC streaming, turn correlation, and error recovery.
