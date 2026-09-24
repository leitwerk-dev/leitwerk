# Terminology

Use these names consistently in contracts, code, and documentation. Backticks identify
code names; operator-facing prose can say “process” rather than `ProcessInstance`.
Behavioral rules belong in the linked references, not in a second glossary.

---

## Process and execution

| Term | Definition |
|---|---|
| **Process / `ProcessInstance`** | One durable workflow execution, including its business position and lifecycle. |
| **Turn** | A code-defined workflow step: LLM, automatic, human, or external. |
| **Process project / `ProcessProject`** | Repository state for one component of a process. |
| **Process input / `ProcessInput`** | A durably sequenced instruction submitted to a process. |
| **Turn record / `ProcessTurnRecord`** | Durable record of one turn execution attempt, its outcome, and its lineage. |
| **`lifecycleStatus`** | Coarse process state: `discovered`, `active`, `waiting`, `error`, `completed`, or `aborted`. |
| **`selectedTurnId`** | Durable pointer to the active or awaited process turn. |
| **`TurnStartRecord`** | Durable preparation for one worker-owned turn that reserves a turn-record id without creating an attempt until accepted. |
| **Mapped LLM turn** | One LLM turn that runs once per frozen item, sequentially. Each item yields a typed result; the turn collects all results and routes once. |
| **Mapped run** | Durable record of one entry into a mapped LLM turn: the frozen items, their results, and the current item. |
| **LLM preparation phase** | Optional deterministic phase inside an accepted LLM turn. It produces bounded prompt input and progress without creating a separate business turn. |
| **`WorkerLease`** | Server-owned durable lifecycle and heartbeat record assigned to a physical worker instance. |
| **`Prepared turn start`** | Read-only tree position prepared by a worker lease before server acceptance. |
| **Agent terminal acknowledgement** | Bounded final agent response after an accepted outcome tool; not a separate business turn. |
| **Terminal fact acknowledgement** | `worker.turn_terminal_recorded`, confirming that the server durably recorded a correlated worker outcome or failure. |

---

## Tools and questions

| Term | Definition |
|---|---|
| **Agent Tool** | Any capability exposed to an AI agent during a turn (built-in primitives, integration tools, interactive tools, or outcome tools). |
| **Built-in Primitives** | Core workspace tools (`read`, `bash`, `edit`, `write`) that control filesystem and shell interaction. |
| **Integration Tools** | Extension-provided tools for interacting with external services. |
| **Outcome Tool** | Terminal tool declared on an LLM turn that returns typed data, publishes markdown, and triggers process state transitions. |
| **`ask_questions`** | Interactive tool enabling agents to pause execution and ask human operators structured multiple-choice questions mid-turn. |
| **Question Request** | Durable pause inside an active LLM turn created by `ask_questions`, awaiting structured operator answers without resetting context. |

---

## Trees and workspaces

| Term | Definition |
|---|---|
| **Instance Tree** | Persisted JSONL file (`<instanceId>.jsonl`) backing the Pi-driven execution lineage and turn entries of a process instance. |
| **Leaf Pointer** | Pointer referencing the active entry in the instance tree. |
| **Primary Path** | Operator-facing main execution branch extending from the top-level entry to the active leaf pointer. |
| **Root Branch** | Branch whose first entry is appended at the session root with `parentId: null`. |
| **Review Branch** | Side branch for review or analysis. The process may restore the primary branch and pass the result back as input. |
| **Pi Resource Snapshot** | Immutable, content-addressed non-secret package containing settings, models, extensions, skills, and prompts for worker materialization. |
| **Workspace Clone** | Dedicated full Git repository clone checked out to a specific work branch (`feat/...`). |
| **Local Session Transfer Grant** | Expiring, process-bound bearer capability minted without reading retained state. SQLite stores only its token hash. |
| **Local Session Transfer Attempt** | Durable queued claim of a grant with a renewable liveness lease, fixed hard deadline, phase progress, and at most one non-terminal owner per process. |
| **Export Reservation** | Exclusive interval after accepted work becomes quiescent, during which no writable worker lease or process mutation may alter the retained snapshot being streamed. |
| **Transfer Receipt** | Local Pi record keyed by origin, grant, and token hash that makes final acknowledgement and session switching recoverable without storing the bearer token. |

---

## Browser UI

| Term | Definition |
|---|---|
| **Chronicle** | Main process timeline pane rendering streaming agent reasoning, tool execution logs, and published markdown products. |
| **Turn Rail** | Navigation beside the Chronicle showing turn history, current work, and the declared next turn. |
| **Product** | Named markdown result published by a turn (e.g., `plan`, `review`) and consumed by subsequent turns. |
| **Product Ref** | Durable pointer linking a published product name to its source turn record. |
| **FIFO Input Queue** | Monotonically sequenced queue of text steering instructions submitted by operators and consumed sequentially by workers. |

---

## Skills

| Term | Definition |
|---|---|
| **Installed Skill** | Skill revision imported into SQLite with an active status available for future process launch selection. |
| **Attached Skill** | Immutable skill revision explicitly pinned to a process instance during launch creation. |
| **Skill Candidate** | Discovered skill revision in a configured Git repository that is available for installation. |
| **Skill Invocation** | Execution event recorded when an assistant explicitly reads a skill's root `SKILL.md` during a turn. |

---

## Avoid ambiguous terms

| Avoid | Use Instead | Reason |
|---|---|---|
| *Agent instance* | **Process instance** | Distinguishes background agent execution from durable process state. |
| *Command service* | **ProcessEngine** | Reflects the core architectural component name. |
| *Detail pane* | **Chronicle** | Standardizes UI timeline naming. |
| *Detail rail* | **Turn Rail** | Standardizes UI navigation rail naming. |
| *Future step* | **Future turn** | Aligns with the turn-based paradigm. |
| *Task* | **Turn** | Avoids confusion with background operational tasks or sub-tasks. |
| *Task run* | **Turn record** | Accurately describes durable execution attempts. |

## Launches

- **Launcher:** Input schema and resolution logic for starting a process.
- **Watcher:** Extension-owned source that starts processes from external events.
- **External action:** A subscribed event that advances an existing process.
- **Launch Run:** Durable, presentation-safe progress record for one launch or startup-retry attempt. It is not authoritative process-startup evidence.
- **Startup Attempt:** Process-detail projection of one turn start and its correlated worker lease, server-observed readiness, and accepted first turn.
- **Launch checklist step:** Ordered operator-facing phase owned by the launch coordinator.
- **Preparation check:** Optional launcher-owned validation that returns or throws a safe failure.
- **Programmatic launch admission:** Trusted extension submission of launcher input plus caller idempotency intent. The server creates the Launch Run and executes the shared pipeline; the caller does not receive the raw process executor.

A Launch Run is not a process instance, worker lease, runner unit, or title job. It references those
facts without storing credentials, provider responses, PIDs, pod names, or container ids.
