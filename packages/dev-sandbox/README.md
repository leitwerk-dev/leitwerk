# Development sandbox harness

`@leitwerk-dev/dev-sandbox` runs the application with an explicit
`SandboxCompositionFactory`. It imports no extensions. The factory receives paths,
scripted/real mode, UI/backend origins, and the selected model profile. It supplies
the catalog, process configuration, named launch configurations, scripted Pi
factory, initialization, controls, polling and cleanup. Adapters own their storage
and scenario counters. Use `StubToolCallScriptResolver`,
`StubPiTreeHandleFactory({ recordSessionTrace: true })`, and ordinary callbacks.

`withSandboxLaunchers` adds normal UI launchers to a copy of a process definition.
The harness admits control-page launches through `/api/launchers/.../launch-runs`
with the caller's idempotency key. An optional `prepareLaunch` callback may prepare
adapter input; it must reconcile its own durable writes. Startup delays belong to
scenario registrations. Controls may emit local events and invoke `/__local/poll`;
they must not assign process lifecycle state.

`createSandboxApp(config, input, factory)` returns the application context, polling,
and an idempotent `stop()` that closes workers, the application and the composition.
Register a composition-owned page at `/__local`. `/__local/state` contains scenario
descriptions, processes and configured URLs alongside composition-owned state.
Controls accept only same-origin browser requests. Listeners use `127.0.0.1`.

The `/launcher` export provides `launchSandbox({ publicRoot, workspaceRoot,
compositionEntry })`. It requires the public source checkout and its installed
development dependencies. The composition entry exports its factory as default.
This release does not provide installed-package sandbox startup. The CLI invokes
the public development supervisor, including configuration reloads and custom
backend/preflight entries. `/preflight` validates with disposable application,
workspace, Pi and adapter storage; it never starts background services.

Storage lives at `<workspace>/.leitwerk/sandbox/{scripted,real}`. `/storage` exports
the confined reset operation. It verifies supervisor identity, retains storage on
shutdown failure, rejects symlinked storage, and keeps the sibling `model.json`.
The launcher passes an allowlisted environment: isolated home/configuration, local
Git identity and file-only Git transport. Ambient provider, Pi, SSH and Node
overrides are excluded. This is a development environment, not a security boundary
for hostile compositions or repository code.

Scripted mode substitutes Pi and bypasses only Docker preflight. Real mode uses
the ordinary Pi SDK and preserves process runtime requirements. Supply dedicated
`model.json` credentials with mode `0600`, containing `model_profiles` and
`providers` (the models extension configuration). Production credentials are never
read. Ports default to UI `5173` and backend `18082`; use `--ui-port` and
`--backend-port` to choose strict alternative ports.
