# Pi Durable prototype

**Verdict: Pi Durable can replace much of Leitwerk's agent execution machinery.
It cannot replace the process engine, external-write reconciliation, or worker
isolation.** A server-owned harness with remote execution environments is a viable
direction; this experiment does not change the production runtime.

The question comes from [Earendil's Pi Durable announcement](https://earendil.com/posts/pi-durable/),
published on 2026-10-01. This experiment pins `pi-durable`, `pi-ai`, and `chord` to
**1.0.2**. The application's coding-agent SDK is **0.81.1**. Pi Durable's published
README labels it experimental and says its API may change without notice.

## What could be replaced

| Leitwerk responsibility | Pi Durable mechanism | Assessment |
| --- | --- | --- |
| Temporary tools, private SDK hooks, continuation handling in [pi-adapter.ts](../../packages/worker/src/pi-adapter.ts) | Registered extensions, tools, hooks, generation tasks | Strong replacement candidate. The prototype uses public Durable APIs. |
| Kickoff prompt identity and interrupted-run recovery in [llm-turn-execution.ts](../../packages/worker/src/runtime/llm-turn-execution.ts) | Persisted submissions with `requestId`, task checkpoints and receipts | Replaces substantial bookkeeping. Keep Leitwerk's acceptance, preparation, required-outcome and result-validation rules. |
| Worker tree upload/download in [session-snapshot-exchange.ts](../../packages/worker/src/session-snapshot-exchange.ts) | Server-owned storage commits | Can disappear for migrated LLM executions. Backup, local export and legacy-tree compatibility remain. |
| Low-level transcript forking and leaf restoration in [turn-tree-strategy.ts](../../packages/worker/src/turn-tree-strategy.ts) | Conversations fork at immutable entries | Replaces the mechanism. Leitwerk still chooses the fork, products, semantic references and primary continuation. |
| Conversation activity reconstruction | `viewState()` and `watch()` over committed state | Useful source for a browser adapter. Does not implement Leitwerk's WebSocket protocol, process view, authorization or inspection UI. |
| [ProcessEngine](../../packages/server/src/process-engine/engine.ts) | Durable task state machines | Retain. Agent tasks do not encode process graphs, business transitions, attempt accounting, mapped turns, actor attribution or process locks. |
| ProcessInput delivery | Durable inbox and submission IDs | Keep process-level targeting and acknowledgements. The experiment checks the native Durable queue, not a complete replacement of ProcessInput delivery. |
| [External writes](../../packages/external-writes/src/external-writes.ts) | Tool `replay: "safe"` | Retain. Permission to rerun a tool does not reconcile an external effect whose receipt was lost. |
| Worker runners, full Git clones, repository operations, provider configuration and managed resources | `ExecutionEnv` and application extensions | Retain policy and isolation; write adapters. Durable supplies interfaces, not these deployment contracts. |

Compaction and provider retry also move into Durable's harness, but their equivalence
to Leitwerk's current contracts is not established by this experiment.

## Placement and credential contract

```text
Browser / process inputs
          |
Trusted server: ProcessEngine + Leitwerk SQLite
          | accepted turn id / outcome receipt
Trusted server: Pi Durable + separate SQLite + providers + integration tools
          | filesystem / shell RPC only
Untrusted worker container: generated Git workspace
```

All credentialed model and integration requests originate in the server. Workers
receive no provider key, integration credential, server bearer token, credential
file, host home mount or Docker socket. The worker has no network, runs as UID
65534 with all capabilities dropped, and mounts only its generated workspace.
Its root filesystem is read-only; `/tmp` is disposable. Shell calls use a fixed
environment, and caller-supplied environment overrides are rejected.

The only worker-side code is [worker.mjs](src/worker.mjs). Every `ExecutionEnv`
operation executes there; none falls back to the server filesystem. Integration
tools run on the server and return selected public fields. Known test credentials
are also blocked at the transport boundary. That detector is a verification aid;
container isolation and keeping credentials out of worker inputs provide the
separation. Credentialed Git fetch/push would need the same server mediation.

The application's current [credential delivery contract](../../docs/security.md#2-secrets-container-isolation)
materializes model credentials inside workers. This prototype intentionally
changes that placement to satisfy the requested stricter contract. The current
local runner, sharing the server's OS identity, cannot provide this separation.
Production adoption must update provider adapters and the documented contract;
switching the harness package alone is insufficient.

## Recovery and measured behavior

The evaluation uses the real ProcessEngine operations, file-backed repositories,
external-write implementation, Durable scheduler, Docker worker, and session
transfer code. A fixture supervisor supplies the existing engine's control-plane
interface; physical worker execution and cancellation use the prototype transport.
`FakeLlmProvider` scripts model responses behind an authenticated localhost HTTP
endpoint. A second authenticated endpoint records ticket effects across server
crashes. No real model account or external integration is called.

Server restart uses **SIGKILL**, not graceful shutdown. Checks cover:

- Acceptance and Durable binding interrupted separately: one accepted attempt
  and one input after recovery.
- Model request, safe external tool and unsafe shell tool interrupted: one user
  input; the ticket reconciles to one external effect; the unsafe effect is not
  replayed and its transcript result reports interruption.
- Crashes immediately before and after the ProcessEngine outcome: one successful
  turn and one transition to the next business turn.
- Stop and Retry: the selected turn stays fixed on failure, Retry creates attempt
  two, and stale commands/outcomes are rejected. A pending outcome for a stopped
  attempt is discarded on reopen.
- Primary → review → primary: two Durable conversations preserve the branch and
  three published product references. Review tools cannot write the workspace.
- Live watch updates, equal committed views after reconnect, Durable's persisted FIFO
  inputs and duplicate submission IDs.
- Export through the real tar/zstd archive and V3 rewriter, opened by Pi's real
  `SessionManager`: review history and product entry IDs remain available, the
  primary branch excludes the review, and the Git clone retains its dirty file.
- Actual container configuration, environment/proc probes, blocked network,
  rejection of deliberately forwarded credentials, and credential scans of the
  worker wire, workspace and model contexts.

There is no atomic transaction spanning the two SQLite files. The adapter first
commits an outcome receipt in Durable, delivers it to ProcessEngine, then marks
it delivered. Reopen reconciles pending receipts against Leitwerk's durable turn
record. This bridge remains application code. A lost model response may require
another provider request and incur another charge; submission deduplication does
not make provider requests or arbitrary external effects exactly-once.

## Run

Requires Node 26.3.0, npm, Git and a local Docker engine. Docker Desktop was used
for this evaluation. From the repository root, prepare dependencies and the
application packages once:

```sh
npm ci
npm run build
npm ci --prefix tools/pi-durable-prototype --ignore-scripts
```

Then run the standalone experiment:

```sh
npm run check --prefix tools/pi-durable-prototype
```

That command typechecks the adapter, builds its worker image and runs the scenarios.
Each run creates fresh `/tmp/leitwerk-pi-durable-*` data and removes its worker
containers. It leaves scratch stores, traces and the local export for inspection;
the output identifies their location. It never opens configured operator storage.
Results go to ignored `results/evaluation.json`; [evaluation.recorded.json](evaluation.recorded.json)
captures the verified run on this branch. Changes here are standalone tooling,
outside the application workspaces, so validation is scoped to this experiment.

## Remaining migration work

The V3 projection is deliberately partial. Positional system updates are retained
as custom history entries, not reproduced as legacy model instructions. Reset,
compaction and context edits fail export explicitly. Tool implementation state,
tasks and submission receipts remain in native Durable storage and cannot be
resumed from a V3 file. Existing histories need an import/projection strategy;
this is not a lossless replacement for the persisted Pi tree format.

The experiment exercises one immutable instruction snapshot and per-turn tool
authorization. It does not integrate the full managed resource catalog, production
provider extensions, production supervisor/IPC, browser WebSocket adapter,
automatic/mapped turns, Continue-from-arbitrary-leaf, multi-component workspace
operations, credentialed Git or large-history pagination. Stop uses the real
AbortTurn and TurnFailed operations, with physical cancellation supplied by the
prototype. It is not an end-to-end validation of the current production supervisor.
Retry was exercised on the initial primary turn; retries of review branches and
other start selections still need the full turn-tree adapter.

Durable owns one store from one process at a time. Cross-store recovery, migration
backups and version pinning need explicit production designs. Its tool recovery
path skips `beforeTool`; authorization must also guard actual execution and the
environment. The adapter does both. Neither a hook nor an `ExecutionEnv` interface
is an OS sandbox.

The next implementation should introduce a server-owned agent-runtime adapter
behind Leitwerk's accepted-turn contract and migrate one process family. Keep the
existing ProcessEngine, repositories and external-write reconciliation. Measure
what can actually be deleted from the old adapter before broad rollout. The
largest gains come from moving harness ownership and storage to the server; the
largest costs are provider/worker rewiring and preserving tree/export semantics.
