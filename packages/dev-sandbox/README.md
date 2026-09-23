# Development sandbox harness

`@leitwerk-dev/dev-sandbox` runs the application with an explicit
`SandboxCompositionFactory`. It imports no extensions. The factory receives paths,
scripted/real mode, UI/backend origins, and the selected model profile. It supplies
the catalog, process configuration, named launch configurations, scripted Pi
factory, initialization, controls, polling and cleanup. Adapters own their storage
and scenario counters. Use `StubToolCallScriptResolver`,
`StubPiTreeHandleFactory({ recordSessionTrace: true })`, and ordinary callbacks.

`withSandboxLaunchers` adds a `sandbox.<name>` UI launcher for each scenario with a
`launch` callback. Use it only in a development composition; SDK definition identity
and turn semantics are retained. The process's own launchers remain available unless
`{ ownLaunchers: "replace" }` hides them. Repeated calls replace earlier scenarios.
A scenario may instead set `launcherId` to admit through an existing launcher, such
as a production launcher simulating an external trigger.

`POST /__local/scenarios` accepts `{ name, requestId, input? }` and admits the launch
through `/api/launchers/.../launch-runs` with `requestId` as its idempotency key.
Optional `prepareLaunch(requestId, input)` seeds adapters and returns launcher input.
Replays repeat the request id, so it must reconcile its own durable writes. Throw
`SandboxControlError(status, message)` to reject a request. Startup delays belong to
scenario registrations. Controls may emit local events and invoke `/__local/poll`;
they must not assign process lifecycle state.

`scriptedSandboxModel` supplies the scripted model provider matching the profile
configured by `sandboxConfig`; use it in scripted mode. `readSandboxSettings(input,
name)` reads composition-owned local settings, such as webhooks, from
`<workspace>/.leitwerk/sandbox/<name>.yaml`. The file must have mode `0600`. Reset
retains it, and preflight reads the same file.

`sandboxConfig(input)` builds isolated defaults for launchers and tests.
`createSandboxApp(config, input, factory)` applies the composition's process
configuration. It returns the application context, polling, and an idempotent
`stop()` that closes workers, the application and the composition. Register a
composition-owned page at `/__local`. `/__local/state` contains scenario
descriptions, processes and configured URLs alongside composition-owned state.
Controls accept only same-origin browser requests. Listeners use `127.0.0.1`.

`/testing` provides `startSandboxHarness(factory)` for integration tests. It starts a
scripted composition on an ephemeral port with disposable storage and supplies
`restart`, `admitScenario`, `controlState` and `stop`.

The `/launcher` export provides `launchSandbox({ publicRoot, workspaceRoot,
compositionEntry })`. It requires the public source checkout and its installed
development dependencies. The composition entry exports its factory as default.
Each storage directory records its composition entry; starting another composition
on it fails until reset.
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
