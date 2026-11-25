# Terminology

Use these names consistently in contracts, code, and documentation. Backticks identify code names; user-facing prose can say “process” rather than `ProcessInstance`.

## Process and execution

| Term | Definition |
| --- | --- |
| **Process / `ProcessInstance`** | One durable workflow execution, including its business position and lifecycle. |
| **Turn** | A code-defined workflow step: LLM, mapped LLM, automatic, human, or external. |
| **Process project / `ProcessProject`** | Repository state for one component of a process. |
| **Process input / `ProcessInput`** | A durably sequenced instruction queued on a process. |
| **Turn record / `ProcessTurnRecord`** | Durable record of one turn execution attempt, its outcome, and its lineage. |
| **`lifecycleStatus`** | Coarse process state: `discovered`, `active`, `waiting`, `error`, `completed`, or `aborted`. |
| **`selectedTurnId`** | Durable pointer to the active or awaited process turn. |
| **Turn readiness** | A server-owned `.waitFor` condition checked before reserving a worker start. Waiting observations are not turn attempts. |
| **`TurnStartRecord`** | Durable preparation for one worker-owned turn that reserves a turn-record ID without creating an attempt until accepted. |
| **Mapped LLM turn** | One LLM turn that runs sequentially once per frozen item, then collects typed item results and routes once. |
| **Mapped run** | Durable record of one entry into a mapped LLM turn: frozen items, collected results, and current item. |
| **LLM preparation phase** | Optional deterministic phase inside an accepted LLM turn producing bounded prompt input and progress without creating a separate turn. |
| **`WorkerLease`** | Server-owned durable lifecycle and heartbeat record assigned to a physical worker instance. |
| **Prepared turn start** | Read-only tree position prepared by a worker lease before server acceptance. |
| **Agent terminal acknowledgement** | Bounded final agent response after an accepted outcome tool; not a separate business turn. |
| **Terminal fact acknowledgement** | `worker.turn_terminal_recorded`, confirming that the server durably recorded a correlated worker outcome or failure. |

## Tools and questions

| Term | Definition |
| --- | --- |
| **Agent tool** | Capability exposed to an AI agent during a turn: workspace primitive, integration tool, interactive tool, or outcome tool. |
| **Workspace primitives** | Core worker tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, plus `checkout_repository` when on-demand checkout is enabled). |
| **Integration tools** | Extension-provided tools executed on the server for interacting with external services. |
| **Outcome tool** | Terminal tool declared on an LLM turn that validates typed parameters, publishes markdown, and selects the next route. |
| **`ask_questions`** | Interactive tool pausing an active LLM turn for structured operator answers without resetting context. |
| **Question request** | Durable pause record created by `ask_questions`. |

## Trees and workspaces

| Term | Definition |
| --- | --- |
| **Instance tree** | Persisted JSONL file (`<instanceId>.jsonl` or `primary.jsonl`) backing the Pi execution lineage of a process. |
| **Leaf pointer** | Pointer referencing the active entry in the instance tree. |
| **Primary path** | Main execution branch from the root entry to the active leaf pointer. |
| **Root branch** | Branch whose first entry is appended at the session root (`parentId: null`). |
| **Review branch** | Side branch for review or analysis; the process can restore the primary branch and pass results back as input. |
| **Pi resource snapshot** | Immutable, content-addressed non-secret package of settings, models, extensions, skills, and prompts for worker materialization. |
| **Workspace clone** | Dedicated full Git clone checked out to a process work branch. |
| **Local session transfer grant** | Expiring, process-bound bearer capability minted without reading retained state; SQLite stores only its token hash. |
| **Local session transfer attempt** | Durable queued claim of a grant with a renewable liveness lease, hard deadline, and at most one non-terminal owner per process. |
| **Export reservation** | Exclusive interval after quiescence during which no writable worker lease or mutation may alter the exported snapshot. |
| **Transfer receipt** | Local Pi record keyed by origin, grant, and token hash enabling recoverable acknowledgement without storing the bearer token. |

## Browser UI

| Term | Definition |
| --- | --- |
| **Chronicle** | Process timeline pane rendering turns, live reasoning/activity, questions, actions, and published results. |
| **Turn Rail** | Navigation beside the Chronicle showing turn history, current work, and the declared next turn. |
| **Product** | Named markdown result published by a turn and consumed by subsequent turns. |
| **Product ref** | Durable pointer linking a published product name to its source turn record. |
| **FIFO input queue** | Monotonically sequenced queue of instructions delivered to workers in order. |

## Skills

| Term | Definition |
| --- | --- |
| **Skill pack** | Extension-owned bundle of adapted skills, dependencies, and upstream provenance built from a pinned source and patch. |
| **Installed skill** | Skill revision imported into SQLite and active for future launch selection. |
| **Attached skill** | Immutable skill revision pinned to a process instance at launch. |
| **Skill candidate** | Skill revision discovered in a configured Git repository and available to install. |
| **Skill invocation** | Event recorded when an agent reads a skill's root `SKILL.md` during a turn. |

## Topic solution wikis

| Term | Definition |
| --- | --- |
| **Topic solution wiki** | Server-owned collection of reusable, evidence-backed findings scoped to one topic; not general agent memory. |
| **Wiki page** | Revisioned entry recording applicability, evidence revisions, and contributing process and turn. |
| **Tombstone** | Durable deletion marker preventing restoration of a deleted wiki page ID. |

## Launches

| Term | Definition |
| --- | --- |
| **Launcher** | Input schema and resolution logic for starting a process. |
| **Watcher** | Extension-owned source that starts processes from external events. |
| **External action** | Subscribed external event that advances an existing process. |
| **Launch run** | Durable, presentation-safe progress record for one launch or startup-retry attempt; not authoritative startup truth and never stores credentials or runtime IDs. |
| **Startup attempt** | Process-detail projection of one turn start and its correlated worker lease, readiness, and accepted first turn. |
| **Launch checklist step** | Ordered operator-facing phase owned by the launch coordinator. |
| **Preparation check** | Optional launcher validation returning or throwing an operator-safe failure. |
| **Programmatic launch admission** | Extension submission of launcher input and idempotency key through the shared launch pipeline without exposing the raw executor. |

## Scoped settings

| Term | Definition |
| --- | --- |
| **Settings subject** | Stable identity of an installation, repository (with verified clone aliases), or extension-defined scope. |
| **Settings override** | Revision-checked value for one setting and subject; reset restores inheritance while advancing the revision. |
| **Execution purpose** | Extension-defined binding from an LLM turn to model and non-secret settings captured when preparing a turn start. |

## Model selection

| Term | Meaning |
| --- | --- |
| **Model requirement** | Hard restriction from code or operator configuration. All effective process and turn layers must match. |
| **Model preference** | Inherited profile considered before automatic ranking. Policy exclusion, not unavailability, can make selection skip it. |
| **Default candidate** | Profile marked `default: true` for automatic ranking. Multiple candidates may coexist. |
| **Model readiness** | Cached availability of the selected profile. It never changes the selection. |

## Avoid ambiguous terms

| Avoid | Use instead | Reason |
| --- | --- | --- |
| *Agent instance* | **Process instance** | Distinguishes background execution from durable process state. |
| *Command service* | **ProcessEngine** | Matches the core architectural component name. |
| *Detail pane* | **Chronicle** | Standardizes UI timeline naming. |
| *Detail rail* | **Turn Rail** | Standardizes UI navigation rail naming. |
| *Future step* | **Future turn** | Aligns with turn-based modeling. |
| *Task* | **Turn** | Avoids confusion with operational tasks or subtasks. |
| *Task run* | **Turn record** | Accurately describes durable execution attempts. |
