# Documentation

Leitwerk coordinates AI workflows, human decisions, and updates from connected systems.
Start with the [overview](overview.md), or choose the task you need to complete.

## Start

- [Overview](overview.md) — What Leitwerk does and who does the work.
- [Run your first process](introduction.md) — Configure a local instance and run a prompt.

## Use

- [Operate a process](operator-guide.md) — Launch, review, guide, recover, and stop work.
- [API tokens](api-tokens.md) — Authenticate HTTP clients and manage tokens.

## Build

- [Write your first process](first-process.md) — A complete TypeScript extension.
- [Process SDK](process-sdk.md) — Turns, products, launchers, and compatibility contracts.
- [Agent tools](agent-tools.md) — Workspace access, integration calls, questions, and outcomes.
- [Watchers](watchers.md) — Start processes from external events.
- [Extension UI renderers](extension-ui.md) — Render results inside supported UI slots.

## Operate

- [Configuration](configuration.md) — Server, worker, and process runtime settings.
- [Models](models.md) — Profiles, credentials, availability, and model selection.
- [Local Docker deployment](docker-deployment-guide.md) — A loopback-only container installation.
- [Kubernetes deployment](kubernetes-deployment-guide.md) — Helm installation and worker infrastructure.
- [Security](security.md) — Authentication, secrets, and isolation boundaries.
- [Backup and upgrades](operations.md) — Protect durable state and plan recovery.

## Contribute

- [Architecture](arc42.md) — System boundaries, constraints, and runtime relationships.
- [Terminology](ubiquitous_language.md) — Shared names and definitions.
- [Server and worker lifecycle](server-worker-lifecycle.md) — Acceptance, supervision, and recovery.
- [LLM turn flow](llm-turn.md) — From worker acceptance to browser updates.
- [Process workspace](process-workspace.md) — Repositories, resources, session trees, and retention.
- [Browser WebSocket protocol](websocket.md) — Frames and reconnect ordering.
- [UI contracts](ui.md) — Navigation, interaction, accessibility, and read-model behavior.
- [Development compositions](development-composition.md) — Develop extensions with released or local core packages.
- [Testing](testing.md) — Validation commands, test boundaries, and harness selection.
- [CI and releases](ci.md) — Required checks and artifact publication.
- [Future work](future.md) — Capabilities outside the supported scope.

These pages describe the intended contracts for this checkout. Use documentation from the
matching release when operating a released installation. Optional extensions own their
provider configuration and process behavior in their package READMEs.
