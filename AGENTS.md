# Process Instructions for leitwerk

Concise guidance for AI processes working in `leitwerk/`.

## 1. Source of truth
When changing the design or implementation, keep these aligned:
- `docs/arc42.md`
- `docs/introduction.md`
- `docs/process-sdk.md`
- `docs/agent-tools.md`
- `docs/server-worker-lifecycle.md`
- `docs/watchers.md`
- `docs/testing.md`
- `docs/configuration.md`
- `docs/ubiquitous_language.md`
- `docs/process-workspace.md`
- `docs/websocket.md`
- `docs/ui.md`
- `docs/llm-turn.md`
- `docs/models.md`
- `docs/development-composition.md`
- `docs/security.md`
- `docs/ci.md`
- `docs/future.md`

Treat `docs/*.md` as the intended target state. Resolve wording drift by updating the docs to the intended contract.
- Follow `WRITING.md` for API docs, semantic rules, compatibility tables, tests, and implementation notes.
- Document extension/process-specific behavior in that extension's `README.md`.
- Do not update cross-cutting `docs/*.md` or `leitwerk.yaml.example` merely because an optional extension/process is added. Update them only when shared contracts, config schema, runtime invariants, or core UX change.
- When config keys change, update `leitwerk.yaml.example` in the same change.

## 2. Technology stack & Product model
- **Server**: Fastify (HTTP + WebSocket via `@fastify/websocket`)
- **UI**: Svelte 5 SPA built with Vite (Unified Processes view, no separate Jira/MR areas)
- **Database**: Drizzle ORM + better-sqlite3 (synchronous)
- **Testing**: Vitest
- **Linting/formatting**: Biome
- **Build**: tsup (server/worker/domain/protocol), tsx (dev), Vite (UI)
- **Pi integration**: `@earendil-works/pi-coding-agent` SDK embedded in workers
- **Product Model**: Process-centric. Public demo processes live in `showcase-processes` (for example `poem_creator_process` and `single_prompt_process`). Loaded dynamically via `jiti`, not statically privileged.

## 3. Package layout & Boundaries
Monorepo using npm workspaces. 
- **Core (`packages/`)**: `domain`, `protocol`, `worker-protocol`, `process-sdk`, `extension-runtime`, `watcher-utils`, `external-writes`, `worker-runners`, `server`, `worker`, `ui`, `test-support`.
- **Extensions (`extensions/`)**: `showcase-processes`, `models`, `coding`, `local-repo-change`, `remote-repo-change`, `git-ssh`, `local-shell`, `pi-shell`, `process-analysis`, `telegram`, etc.

**Hard Rule:** Core packages under `packages/` must **never** import from `extensions/` (applies to runtime, tests, and types). Top-level `tests/` should import via package specifiers (e.g., `@leitwerk-dev/domain`).

## 4. Architecture & Runtime Invariants
- **State Ownership:** The server is the exclusive source of truth for durable state. Workers are disposable and **never** access SQLite. All state flows via IPC (stdin/stdout).
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
- **Required Checks:** Before merge, confirm both `Full validation` and `Conventional PR title and DCO` pass. See `CONTRIBUTING.md` and `docs/ci.md` for the complete policy.

## 7. Testing & Operational Directives
- **Change Completion:** A change is not complete until `npm run test:full` passes (lint, build, typecheck, tests). Do not substitute with partial workspace runs.
- **Test Failure Triage:** If tests fail in `packages/*/dist` or `extensions/*/dist`, suspect stale build artifacts. **Never edit `dist/` by hand.** Run `npm run build` (or `npm run build -w <workspace>`) before debugging logic.
- **Running vitest**: Always rebuild before running vitest to avoid stale artifacts.
- **Schema Changes:** Test migrations against file-backed storage and verify durable data survives. Do not delete operator data automatically. Preserve durable process, workspace, and tree state.
- **Fakes:** Use `FakeLlmProvider` and extension-owned fakes for boundary testing. Avoid broad mocking.
- **Test Levels:** Unit tests should be simple to setup, due to the functional core. Integration tests can use the test support utilities for leitwerk-managed Pi instances and fake external services. Those tests live within the package. Broad system tests are located under `tests/` and should import via package specifiers.

## 8. MVP Boundaries
These are not MVP features. Keep them in `docs/future.md` until explicitly promoted:
- per-process/per-tenant authorization or tenant isolation (single-provider SSO + attribution is in scope)
- process-to-process creation
- config-defined processes
- arbitrary process-defined UI plugins
- macOS sandboxing
- rate limiting, request quotas, or storage quotas without a concrete need; current deployments are semi-trusted
