# Public development sandbox

Run the real UI, API, SQLite database and worker runtime with a local notebook and
scripted Pi turns. Node 26, Git and this checkout's development dependencies are
required. Scripted mode needs no provider credentials or Docker daemon.

```sh
npm ci
npm run dev:sandbox
```

Open the UI at http://127.0.0.1:5173 and controls at
http://127.0.0.1:18082/__local. Both ports are strict loopback listeners. Use
`--ui-port=19173 --backend-port=19082` to change them; controls and receipt links
use the configured origins. The source supervisor provides UI hot reload and
preflighted backend/configuration reloads. Preflight uses disposable SQLite, Pi,
workspace and adapter directories.

## Scenarios

All scenarios launch the sandbox-owned `sandbox_repository_change_process` through
the normal launcher API. Approve plans and implementations in the ordinary process UI.
Scripts edit workspace files; the process writes the final commit and publishes its
feature branch to the local bare repository.

| Scenario | Interaction |
| --- | --- |
| `repository-change` | Review a plan, approve implementation, then publish a real notebook commit. |
| `ticket` | Use **Create issue** on a plan result, describe the issue and review the draft. |
| `question` | Answer a notebook question before reviewing the plan. |
| `long-message` | Inspect a long Markdown plan, reasoning and turn details. |
| `streaming` | Watch delayed text and thinking events, then inspect their persisted trace. |
| `failure` | Retry the failed planning turn through the normal process UI. |
| `turn-rail` | Run and accept three automated plan reviews. Planning pass four asks a question. |
| `startup` | Inspect a 7-second connection delay and 1-second preparation delay. |
| `startup-cold` | Inspect a 10.8-second connection delay and 1-second preparation delay, or cancel startup. |

For tickets, the public composition registers `LocalTicketAdapter` from
`@leitwerk-dev/ticket-creation/testing` with Garden and Workshop destinations.
The normal ticket process keeps parent context immutable, resolves the selected
destination on the server, requests approval and requires a durable receipt.
Refine or decline the draft in its process UI. **Lose the next ticket response**
persists one ticket before losing its response; reconciliation records the receipt
without duplicating the ticket. Controls display the local tickets and their URLs.

## Storage and recovery

Storage lives below ignored `.leitwerk/sandbox/scripted/`: `application.sqlite`,
Pi sessions, workspaces, Git repositories, `scenarios.json` and `tickets.json`.
Replay creates fresh process/branch identities. Restart retains waiting decisions,
scenario progress and recorded Pi input, thinking and tool results. Interrupted
turns follow normal recovery and may require **Retry failed turn**. Scripted
reasoning is scene content; it does not represent a real model call.

```sh
npm run sandbox:reset
```

Reset stops the recorded supervisor, verifies its identity and removes only the
scripted and real session directories. It rejects symlinks and reused process IDs,
retains data if shutdown is unconfirmed, and preserves `model.json`. After a
supervisor crash, stop any remaining sandbox processes before removing its retained
`supervisor.pid` record and retrying reset.

## Real models

Create `.leitwerk/sandbox/model.json` with mode `0600` and dedicated credentials:

```json
{
  "model_profiles": [
    { "id": "sandbox-real", "provider": "openai", "model_id": "YOUR_MODEL_ID", "thinking_level": "off" }
  ],
  "providers": { "openai": { "api_key": "YOUR_DEDICATED_KEY" } }
}
```

The `providers` block follows the models extension configuration. Then run:

```sh
npm run dev:sandbox -- --llm=real
```

Real mode uses the Pi SDK, stores data separately in `.leitwerk/sandbox/real/`,
and retains the selected process's runtime requirements, including Docker for
coding processes. The launcher supplies an isolated home, strips ambient provider,
Pi, SSH and Node overrides, and permits only file Git transport. Model credentials
use normal managed worker bootstrap. Repository and ticket adapters remain local.

## Composition and verification

`@leitwerk-dev/dev-sandbox` owns startup, worker selection, lifecycle cleanup,
launcher admission, shared controls, environment construction and reset. This
directory owns the catalog, notebook, scripts and control page. The harness imports
no extensions. `createNotebookComposition(seed)` accepts a notebook name and seed
files; initialization creates real Git history once. Custom compositions export a
`SandboxCompositionFactory` and can be selected through
`LEITWERK_SANDBOX_COMPOSITION_ENTRY`; `LEITWERK_SANDBOX_WORKSPACE_ROOT` selects a
workspace with a `package.json`. No discovery mechanism is involved.

Startup is source-only and requires this checkout's supervisor and UI tooling.
The package does not include these built-in scenarios or offer installed-release
startup. See [the harness contract](../packages/dev-sandbox/README.md).

Run `npm run test:full`. Public coverage includes every scripted scenario, real
commit/publication, questions, approvals and ticket reconciliation, restart persistence,
source reload, strict ports and reset confinement. Sandbox source, scripts and
workflow fixtures participate in lint, typechecking and tests. This environment
does not simulate production scheduling or deployment.

## Local integration composition

Run the public-only Forgejo/GitHub/Woodpecker composition with:

```sh
LEITWERK_SANDBOX_COMPOSITION_ENTRY="$PWD/sandbox/provider-composition.ts" npm run dev:sandbox
```

It adds local `examples/garden` and `examples/workshop` repositories to the public
notebook scenarios. Ticket creation can use Forgejo through the normal derived-ticket
route and approval UI. The adapters register the production tools and polling.
Provider state persists separately in `forgejo.json`, `github.json`, and
`woodpecker.json`. Use the integration `/testing` exports to seed repositories,
add feedback, merge PRs, publish CI results and supply arbitrary release assets.
The composition needs no provider credentials or private checkout.
The default notebook composition and its scenario names remain unchanged. This
explicit provider composition also loads `forgejo-repo-change` with Docker disabled.
It retains the production UI launcher, its repository/SSH admission checks, and
adds these scenes:

| Scene | Behavior |
| --- | --- |
| `forgejo-change` | Plan, approve, implement, approve, publish, then handle review, CI and PR outcomes. |
| `forgejo-feedback-no-change` | Diagnose feedback and reply without publishing a new commit. |
| `forgejo-feedback-operator` | Park review work for operator action. |
| `forgejo-ci-restart` | Read pipeline/log evidence, explicitly restart, and wait. |
| `forgejo-ci-operator` | Park CI work for operator action. |

The control page creates labeled source issues through durable provider writes.
Only the production `use_leitwerk` watcher launches those issues. Use the normal
parent-result **Create issue** route to derive an additional approved Forgejo ticket.
The two routes can run together. PR controls add conversation, inline or review
feedback, run a deterministic notebook check, publish CI outcomes/logs, advance
or conflict the base, merge, close, and cancel source issues by either signal.
The actual repository, branch and Git SHA identify all evidence. A failing
`check.txt` is repaired by the scripted CI turn; `check.mjs` also runs the check
from the checkout. Conflict repair resolves the text conflict and continues the
retained Git rebase before the workflow publishes with its original-head lease.

**Poll providers** advances the shared persisted clock by one minute. Adapters and
polling use that clock, so two-minute feedback quiet periods remain observable.
Controls invoke polling after provider writes. They never select process turns or
set delivery/lifecycle state. `POST /__local/providers/control` requires an operation,
`requestId`, full repository name and relevant PR/issue `number`. Reusing a request
ID returns its recorded result; changing that request is rejected. Use
`lost-ticket-response` or `lost-pr-response` with `enabled: true` to exercise writes
whose provider response is lost.

The new control receipts live in `provider-controls.json`; the clock remains in
`providers-clock.json`. Existing provider files, notebook/scenario counters,
database paths and Pi sessions are preserved. Reaction/reply correlation fields
have legacy defaults. `createProviderComposition(seeds)` accepts configurable public
repository seeds; file remotes are admitted only for those seeds, through confined
local read and dry-run write checks. Production keeps real SSH credential bootstrap.
The provider composition, scripts and controls live here; the sandbox harness
remains provider independent.
