# Testing Directives & Test Harnesses

This guide explains how to test code across the Leitwerk monorepo. Read this document to understand test layer boundaries, Vitest setup, using fakes over broad mocks, and running the mandatory completion gate (`npm run test:full`).

---

## 1. Core Principles & Verification Commands

### Verification Commands

```bash
# Run full monorepo build, lint, typecheck, and test suite (mandatory gate)
npm run test:full

# Run tests in watch mode during development
npm run test

# Rebuild packages if tests fail in dist/ due to stale build artifacts
npm run build
```

### Core Principles

- **Functional Core, Imperative Shell:** Pure domain logic, graph routing, and codecs are isolated from side effects. This makes them fast and simple to unit test without booting Fastify servers or physical workers. Imperative boundaries use deterministic fakes (`FakeJiraClient`, `FakeLlmProvider`) rather than broad mocks.
- **Avoid Change Detector Tests:** Tests verify business behavior, not implementation details. For example, prompt tests assert runtime variable interpolation and sentinel values—never literal prompt prose—so harmless text edits don't break tests.

---

## 2. Test Layers

- **Pure Unit Tests:** Test domain rules, state reducers, graph validation, and codecs without booting Fastify servers or workers.
- **Package Integration Tests:** Test package host behavior using synthetic processes and fakes.
- **Extension Tests:** Test extension catalog registration, custom turns, watchers, outcome tools, and external provider integrations.
- **Server & Worker System Tests:** Boot Fastify with in-memory SQLite and fake boundaries to test `ProcessEngine` lock coordination, WebSocket IPC streaming, turn correlation, and error recovery.
