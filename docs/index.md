# Documentation

Leitwerk documentation provides complete contracts, authoring guides, and operational references for running AI coding agents. Choose your path below depending on whether you are exploring concepts, building workflows, or operating clusters.

## 1. Explore & Understand Leitwerk

- [Introduction](introduction.md) — High-level overview, key features, and built-in showcase examples.
- [Architecture Overview (Arc42)](arc42.md) — System goals, package boundaries, C4Context diagram, and runtime invariants.
- [Terminology & Ubiquitous Language](ubiquitous_language.md) — Canonical definitions (`ProcessInstance`, `WorkerLease`, `Product`).

## 2. Build Processes & Extensions (Authoring Track)

- [Process SDK](process-sdk.md) — Build custom TypeScript processes, turn graphs, launchers, and external actions.
- [Agent Tools & Outcomes](agent-tools.md) — Built-in primitives (`read`/`edit`), integration tools (Jira/GitLab), `ask_questions`, and outcome tools.
- [Automated Watchers](watchers.md) — Event-driven watchers for Jira issues, GitLab MRs, and filesystem events.
- [Process Workspace](process-workspace.md) — Repository cloning, workspace layout, and skill aggregation.

## 3. Deploy & Operate Leitwerk (Operations Track)

- [Configuration Reference](configuration.md) — Complete `leitwerk.yaml` reference, model profiles, reload classes, and environment overrides.
- [Development Compositions](development-composition.md) — Combine this checkout with external packages, extensions, reload, and the full test gate.
- [Server & Worker Lifecycle](server-worker-lifecycle.md) — ProcessEngine supervision, worker adoption, IPC protocol, and crash recovery.
- [Local & Docker Deployment](docker-deployment-guide.md) — Single-machine Docker installation and local dev setup.
- [Kubernetes Deployment Guide](kubernetes-deployment-guide.md) — Production Kubernetes runner configurations.

## 4. Core Specifications & Internal Contracts (Developer Track)

- [Browser WebSocket Protocol](websocket.md) — Frame schemas, ordering, and reconnect behavior.
- [UI Chronicle & Read Models](ui.md) — Browser state and read-model ownership.
- [Testing Directives](testing.md) — Monorepo test layers, Vitest harnesses, and fake clients.
- [Security & Authentication](security.md) — OIDC authentication, attribution, and security boundaries.
- [Future Work & Exclusions](future.md) — Roadmap boundaries and non-MVP features.
