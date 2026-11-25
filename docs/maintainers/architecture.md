# Architecture

The server owns durable process state. Workers execute assigned turns and report results. The browser displays server-owned state and submits operator commands. You can watch these roles in action in the [retry tutorial](index.md).

## 1. Introduction and goals

Leitwerk coordinates code-defined AI workflows with human decisions and external integrations.

| Goal | Architectural response |
| --- | --- |
| Extensibility | Load processes, tools, providers, and watchers through extension contracts. |
| Visibility | Retain execution history and stream current activity to the browser. |
| Recovery | Reconcile durable process and worker state after interruption. |
| Isolation | Separate worker execution from server storage and credentials. |
| Ordered mutation | Sequence process inputs and serialize lifecycle changes per process. |

Operators launch, review, and recover work. Extension authors define workflow behavior. Core maintainers own coordination, persistence, transport, and the shared UI.

## 2. Constraints

- **POSIX only:** macOS and Linux; Windows is not supported.
- **Hard package boundary:** Core packages under `packages/` never import `extensions/` in runtime code, tests, or types.
- **Single SQLite writer:** The server is the only SQLite writer; workers never access the database.
- **Single instance tree:** Multi-component processes still share one durable instance tree.
- **Deferred extension reactions (ADR-023):** Per-process lifecycle mutations run under exclusive coordination; extension host events emitted during a mutation run after the lock releases.
- **Configuration boundary:** Configuration supplies wiring and runtime defaults, not process graphs, transitions, or actions.
- **Single-server scope:** Per-tenant isolation and multi-server coordination are not implied by authentication or idempotency.

Implementation stack: Fastify (`@fastify/websocket`), SQLite with Drizzle and `node:sqlite`, Svelte 5 + Vite, and `@earendil-works/pi-coding-agent` embedded in workers.

## 3. Context

```mermaid
flowchart LR
    people[People] <--> browser[Browser UI]
    browser <-->|HTTP and WebSocket| server[Server]
    server <-->|Authenticated worker protocol| worker[Worker]
    server <--> tools[Team tools]
    worker <--> models[Model providers]
    worker <--> repos[Repository clones]
    server --> state[(SQLite and retained snapshots)]
```

Extensions connect team tools through server-owned integration calls and polling. Workers receive only the tools and credentials authorized for their work. Repository code and model output are untrusted input, never server configuration.

The server owns OIDC admission and retained authentication claims. Claims remain separate from actors and worker payloads; see [Security](../admin/security.md).

## 4. Solution strategy

Keep decisions pure where possible: graph validation, transition rules, and read-model projection perform no external I/O. Server handlers, worker drivers, and extension event handlers coordinate I/O around those rules.

Workers are disposable execution units, not owners of business state. Their retained workspace and tooling survive worker replacement, but process volumes require independent backups to survive volume loss; see [Backup and upgrades](../admin/backup-and-upgrades.md).

## 5. Building blocks

```likec4-view
containers
```

All 18 workspace packages under `packages/`:

| Package | Responsibility |
| --- | --- |
| `domain` | Durable entities and pure domain rules. |
| `protocol` | HTTP contracts, browser WebSocket frames, forms, launchers, and read models. |
| `worker-protocol` | Server–worker WebSocket IPC messages, snapshots, and worker API version. |
| `process-sdk` | Code-defined processes, `flow.*` builders, tool/watcher/settings/provider/UI extension contracts. |
| `extension-runtime` | Dynamic extension discovery (`jiti`), catalog assembly, and runtime setup. |
| `watcher-utils` | Polling schedules and coordination for extension watchers. |
| `external-writes` | Idempotent `ensure` / `logOnly` external-write contracts and publication receipts. |
| `worker-runners` | Local, Docker, and Kubernetes execution units, volumes, and read-only state exporters. |
| `server` | Fastify HTTP/WS API, `ProcessEngine`, SQLite/Drizzle persistence, auth, and worker supervisor. |
| `worker` | Isolated worker entry, Pi SDK tree driver, workspace prep, and snapshot upload. |
| `ui` | Svelte 5 SPA (Dashboard, Launcher, Chronicle, Turn Rail, Inspector, Settings, Skills, Watchers). |
| `wiki` | Topic solution wiki models, SQLite storage, HTTP routes, tools, and Svelte UI. |
| `workflow-graph` | Pure workflow layout and shared Svelte renderer used by the UI and synthetic preview. |
| `session-transfer` | Portable workspace/session archive format, confinement checks, and limits. |
| `pi-session-transfer` | CLI and importer for transferring a Leitwerk process session into local Pi. |
| `test-support` | `FakeLlmProvider`, fixtures, and process/integration test harnesses. |
| `dev-tools` | `leitwerk-dev` CLI for external extension workspaces, skill packs, API checks, and benchmarks. |
| `dev-sandbox` | Credential-free sandbox runner (`npm run dev:sandbox`) using explicit compositions. |

Standalone prototypes under `tools/` (outside core runtime):

- `tools/api-explorer-prototype`: static package export/usage workbench and read-only findings API.
- `tools/workflow-graph-prototype`: standalone synthetic preview of `@leitwerk-dev/workflow-graph`.

Provider and process behavior belongs to extensions under `extensions/`, not privileged core integrations. UI extensions use bounded slots; see [UI renderers](../extensions/ui-renderers.md).

## 6. Runtime view

[Launch admission](../extensions/launchers-and-readiness.md) commits process creation before asynchronous worker startup. [Worker acceptance](server-worker-lifecycle.md#when-a-start-becomes-an-attempt) distinguishes work that actually started from work merely reserved for a worker. Errors park the process without moving it to a different business step, so retry remains a runtime operation rather than a graph branch.

See [LLM turn flow](llm-turn.md) for execution and [Local Pi session transfer](process-workspace.md#local-pi-session-transfer) for handing a quiescent process back to a developer.

## 7. Deployment

| Runner | Use | Boundary |
| --- | --- | --- |
| Local | Development and tests | Host subprocess; no container isolation. |
| Docker | Single-machine deployment | Worker container and retained process volume. |
| Kubernetes | Cluster deployment | Worker Pod in a process namespace with a retained PVC. |

```likec4-view
kubernetesDeployment
```

C4 context, container, and component views plus local, Docker, and Kubernetes deployment views live as a [LikeC4](https://likec4.dev/) model in `docs/maintainers/likec4/`. All views are collected in [Architecture diagrams](architecture-diagrams.md); click a diagram to browse the model, or edit it locally with `npx likec4 start docs/maintainers/likec4`.

Container isolation depends on operator-selected privileges and runtimes; see [Security](../admin/security.md), [Docker deployment](../admin/deploy-docker.md), and [Kubernetes deployment](../admin/deploy-kubernetes.md).

## 8. Cross-cutting contracts

| Contract | Canonical reference |
| --- | --- |
| Acceptance, stale outcome rejection, retry, snapshots | [Server and worker lifecycle](server-worker-lifecycle.md) |
| Idempotent external writes and reconciliation | [External writes and adapters](../extensions/external-writes-and-adapters.md#typed-external-writes) |
| Managed, content-addressed non-secret Pi resources | [Process workspace](process-workspace.md) |
| Credential delivery and trust boundaries | [Security](../admin/security.md) |
| Browser snapshot authority and reconnect ordering | [Browser WebSocket protocol](websocket.md) |
| Storage migration and disaster recovery | [Backup and upgrades](../admin/backup-and-upgrades.md) |
| Scoped settings declarations, resolution, and turn capture | [Scoped settings](../extensions/scoped-settings.md) |
| Topic solution wiki hosting and contracts | [Wiki package reference](../../packages/wiki/README.md) |

## 9. Decisions

SQLite gives the singleton server one durable transaction boundary. Workers exchange facts over authenticated IPC rather than accessing storage. Full repository clones keep component work independent of host worktrees. Extension contracts keep provider and business behavior outside core packages.

## 10. Quality scenarios

Design invariants verified across the suite:

- A repeated start acknowledgement does not create a second turn attempt.
- A stale worker outcome cannot mutate a newer attempt.
- Restart reconciles retained state without resetting configured storage.
- Browser reconnect rebuilds authoritative state and applies only newer live events.
- Repeating an external write reconciles remote identity instead of duplicating it.

## 11. Limits

Authentication is application-wide without tenant isolation. External-write serialization is scoped to one server process. Arbitrary process-to-process spawning is unsupported; the operator-initiated ticket draft flow is a constrained exception whose lifecycle is independent of its parent. See [Future work](future.md).

## 12. Terminology

Use the shared [terminology](terminology.md).
