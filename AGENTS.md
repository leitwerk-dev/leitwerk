# Process Instructions for leitwerk

Concise guidance for AI processes working in `leitwerk/`.

## 1. Source of truth
When changing the design or implementation, keep the relevant docs aligned:
- **Users (`docs/users/`):** `index.md`, `operate-processes.md`, `skills.md`, `settings.md`, `solution-wiki.md`, `api-tokens.md`
- **Admin (`docs/admin/`):** `index.md`, `local-quickstart.md`, `deploy-docker.md`, `deploy-kubernetes.md`, `configuration.md`, `models.md`, `security.md`, `backup-and-upgrades.md`
- **Extensions (`docs/extensions/`):** `index.md`, `first-process.md`, `development-setup.md`, `process-sdk.md`, `launchers-and-readiness.md`, `agent-tools.md`, `watchers.md`, `external-writes-and-adapters.md`, `scoped-settings.md`, `model-providers.md`, `skill-packs.md`, `ui-renderers.md`, `testing.md`
- **Maintainers (`docs/maintainers/`):** `index.md`, `architecture.md`, `architecture-diagrams.md`, `terminology.md`, `server-worker-lifecycle.md`, `llm-turn.md`, `process-workspace.md`, `websocket.md`, `ui-contracts.md`, `development-compositions.md`, `documentation.md`, `testing.md`, `ci-and-releases.md`, `future.md`

Treat `docs/**/*.md` as the intended target state. Resolve wording drift by updating the docs to the intended contract.
- Follow [Plan documentation](docs/maintainers/documentation.md) when shaping an audience’s learning path, and [WRITING.md](WRITING.md) when writing contracts, compatibility tables, tests, and implementation notes.
- Document extension/process-specific behavior in that extension's `README.md`.
- Do not update cross-cutting `docs/**/*.md` or `leitwerk.yaml.example` merely because an optional extension/process is added. Update them only when shared contracts, config schema, runtime invariants, or core UX change.
- When config keys change, update `leitwerk.yaml.example` in the same change.

## 2. Technology stack & Product model
- **Server**: Fastify (HTTP + WebSocket via `@fastify/websocket`)
- **UI**: Svelte 5 SPA built with Vite (Unified Processes view, no separate tracker/MR areas)
- **Database**: Drizzle ORM + `node:sqlite` (synchronous)
- **Testing**: Vitest
- **Linting/formatting**: Biome
- **Build**: Turbo (`npm run build`), tsup (server/worker/domain/protocol), tsx (dev), Vite (UI), Zensical (`npm run docs:build`)
- **Pi integration**: `@earendil-works/pi-coding-agent` SDK embedded in workers
- **Product Model**: Process-centric. Poem Creator lives in `showcase-processes`; prompt and Kubernetes smoke processes live in `example-processes`. Loaded dynamically via `jiti`, not statically privileged.

## 3. Package layout & Boundaries
Monorepo using npm workspaces. 
- **Core (`packages/`)**: `dev-sandbox`, `dev-tools`, `domain`, `extension-runtime`, `external-writes`, `pi-session-transfer`, `process-sdk`, `protocol`, `server`, `session-transfer`, `test-support`, `ui`, `watcher-utils`, `wiki`, `worker`, `worker-protocol`, `worker-runners`, `workflow-graph`.
- **Extensions (`extensions/`)**: `showcase-processes`, `example-processes`, `models`, `coding`, `forgejo-repo-change`, `git-ssh`, `process-analysis`, `telegram`, etc.

**Hard Rule:** Core packages under `packages/` must **never** import from `extensions/` (applies to runtime, tests, and types). Top-level `tests/` should import via package specifiers (e.g., `@leitwerk-dev/domain`).

## 4. Architecture & Runtime Invariants
- **State Ownership:** The server is the exclusive source of truth for durable state. Workers are disposable and **never** access SQLite. All state flows via authenticated WebSocket (`/internal/workers/connect`) and session-snapshot HTTP uploads.
- **SQLite Schema Migrations:** Every durable schema change requires an explicit migration. Startup backs up file-backed SQLite before applying known migrations atomically, validates the result, and rejects unknown drift. Never reset configured storage automatically.
- **Process Lineage:** Multi-component work is still *one* process instance with *one* persisted instance tree.
- **Pi Integration:** Local workers force Pi to use the leitwerk-managed `pi.agent_dir` (`~/.pi/agent` is ignored). Tree-first API via `SdkPiTreeHandle`.
- **Pi resources and credentials:** The server creates immutable, content-addressed non-secret Pi resource snapshots. Each physical worker materializes a verified snapshot below the managed `pi.agent_dir`, writes the current credential layer with mode `0600`, and uses Pi's standard file-backed loading path. Never import ambient Pi files or repository Pi resources. Repository skills, prompts, and extensions remain future work.
- **Concurrency (ADR-023):** Per-process lifecycle mutations must run under server-side exclusive coordination. Extension host events emitted during a mutation (`mutateProcess`) must be deferred until the lock is released to prevent deadlocks.
- **Workspaces:** Full git clones per component, not worktrees. `AGENTS.md` and skills are aggregated into the process workspace.
- **Platform Target:** POSIX environments (macOS/Linux) only. Windows is not a supported target.
- **Idempotency:** External writes from integrations must use `ensureWrite()` and be safe to retry.
- **functional core, imperative shell:** Core logic should be pure and side-effect free where possible. The server/worker entry points and extension event handlers are the imperative shell that orchestrates side effects.
- **Error Model:** Error is orthogonal to business position: current `selectedTurnId` + `lifecycleStatus` + failed turn record. Turn failures keep the selected turn unchanged and park via `lifecycleStatus = error`. No terminal `failed` state — only `completed` and `aborted`. No generic `waiting_for_input` state.
- **Turn-Record Correlation:** Worker outcomes carrying a `turnRecordId` must be rejected when they don't match the process's current expected turn record. Prevents stale branches from mutating durable state.
- **Start acceptance:** `TurnStartRecord` prepares one worker-owned selected turn and reserves its turn-record id. It is not an attempt. Only acknowledged `worker.turn_started` acceptance creates the `ProcessTurnRecord` and increments its attempt. Automatic worker handlers also wait for acceptance.
- **Retry:** Generic infrastructure, not a process-defined action. Operates on failed turn records.
- **Outcome Tools:** Turn-specific outcome tools are registered as `customTools` while the turn is active and unregistered when it ends.
- **Config Boundary:** Config provides wiring, credentials, model catalogs, and process-scoped runtime defaults. Config must not define process types, turn graphs, transitions, completion policies, or action behavior. It may define runtime defaults for loaded code-defined processes, such as process-level default model selection and per-turn runtime settings, keyed by process id and turn id.
- **Model Switching:** Only affects future LLM calls, never the in-flight turn.
- **Providers:** Provider definitions belong to their owning extensions. Startup collects them before `setupServer()`, parses owner-scoped configuration, and keeps credentials in the encrypted server store. A missing credential makes profiles unavailable; malformed provider configuration fails startup.

## 5. Domain Entities (Ubiquitous Language)
Core types live in `packages/domain/src/domain-model.ts`:
- `ProcessInstance`: Durable record (id, selectedTurnId, lifecycleStatus, planRevision).
- `ProcessTurnRecord`: Durable execution lineage (attempt, turnId, branch type).
- `ProcessProject`: Per-component repository state (locator, base/feature branches, MR info).
- `ProcessInput`: FIFO-sequenced input queue per process.
- `WorkerLease`: Server-owned process lifecycle and heartbeat record.

## 6. Contribution Policy
- **PR Titles:** Use Conventional Commits syntax: `type(scope)!: description`. Allowed types are `feat`, `fix`, `docs`, `test`, `ci`, `build`, `chore`, `refactor`, `perf`, and `revert`.
- **DCO Sign-off:** Every commit must contain a `Signed-off-by` trailer matching the commit author's name and email. Create commits with `git commit -s`. Repair an existing commit with `git commit --amend -s` (or sign off each commit during an interactive rebase).
- **Required Checks:** Before merge, confirm both `Full validation` and `Conventional PR title and DCO` pass. See `CONTRIBUTING.md` and `docs/maintainers/ci-and-releases.md` for the complete policy.

## 7. Testing & Operational Directives
- **Change Completion:** Changes to application code, shared contracts, application dependencies, or application build/test/runtime configuration require `npm run test:full` (lint, build, typecheck, tests) to pass. Partial workspace runs do not replace full validation for these changes.
- **Scoped Validation:** For documentation-only changes (including `AGENTS.md`), review the diff for correctness and consistency and run `npm run docs:build` (plus `node --import tsx scripts/check-doc-examples.mjs` after `npm run build` when examples change). For standalone helper scripts that do not affect the application or its build/test/runtime paths, use syntax checks and focused smoke checks. These changes do not require `npm run test:full`; complete them once the relevant checks pass. The pre-merge required checks in section 6 still apply.
- **Isolated Tools:** Changes confined to `tools/api-explorer-prototype/` use `npm run check --prefix tools/api-explorer-prototype` and focused browser/visual checks for UI changes. Changes confined to `tools/workflow-graph-prototype/` use `npm run check --prefix tools/workflow-graph-prototype` and focused browser/visual checks for UI changes. Do not run `npm run test:full` for changes confined to either tool; application changes made alongside them still follow Change Completion.
- **Test Failure Triage:** If tests fail in `packages/*/dist` or `extensions/*/dist`, suspect stale build artifacts. **Never edit `dist/` by hand.** Run `npm run build` (or `npm run build -w <workspace>`) before debugging logic.
- **Built-Artifact Suites vs Vitest:** Workspace Vitest projects alias packages to live TypeScript sources, while Playwright browser tests, `test:parity`, `api:check`, and `scripts/check-doc-examples.mjs` execute built `dist/` outputs — run `npm run build` before running those built-artifact checks.
- **Schema Changes:** Test migrations against file-backed storage and verify durable data survives. Do not delete operator data automatically. Preserve durable process, workspace, and tree state.
- **Fakes:** Use `FakeLlmProvider` and extension-owned fakes for boundary testing. Avoid broad mocking.
- **Test Value:** Add tests for observable contracts and concrete failure modes not already covered. Set expected results independently of implementation logic; tests must survive behavior-preserving refactors. Running the required suite does not imply adding a test for every edit.
- **Configuration Checks:** Prefer native validators and focused execution checks over tests that mirror source/YAML structure, internal names, expressions, or wiring. Assert an exact representation only when that representation is itself a supported contract.
- **Test Levels:** Unit tests should be simple to setup, due to the functional core. Integration tests can use the test support utilities for leitwerk-managed Pi instances and fake external services. Those tests live within the package. Broad system tests are located under `tests/` and should import via package specifiers.
- **API Classification:** Use `@internal` by default for exported declarations and members. Use `@public` only when the declaration is an intentionally supported external API and its compatibility contract has been established.

## 8. MVP Boundaries
These are not MVP features. Keep them in `docs/maintainers/future.md` until explicitly promoted:
- per-process/per-tenant authorization or tenant isolation (single-provider SSO + attribution is in scope)
- process-to-process creation
- config-defined processes
- arbitrary process-defined UI plugins
- macOS sandboxing
- rate limiting, request quotas, or storage quotas without a concrete need; current deployments are semi-trusted
