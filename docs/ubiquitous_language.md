# Ubiquitous Language & Terminology

This document defines the ubiquitous language for Leitwerk. It is the authoritative reference for names across the system: if a concept has a standard name here, that exact term must be used in TypeScript types, database columns, API endpoints, and browser copy.

---

## 1. Process & Execution Lifecycle

| Term | Definition |
|---|---|
| **`ProcessInstance`** | Durable SQLite record representing a running or completed workflow execution (`id`, `selectedTurnId`, `lifecycleStatus`, `planRevision`). |
| **`ProcessTurnRecord`** | Durable record of one turn execution attempt (`attempt`, `turnId`, `branchType`, `lifecycleStatus`). |
| **`lifecycleStatus`** | Coarse process state: `discovered`, `active`, `waiting`, `error`, `completed`, or `aborted`. |
| **`selectedTurnId`** | Durable pointer to the active or awaited process turn. |
| **`TurnStartRecord`** | Durable preparation for one worker-owned turn that reserves a turn-record id without creating an attempt until accepted. |
| **`WorkerLease`** | Server-owned durable lifecycle and heartbeat record assigned to a physical worker instance. |
| **`Prepared turn start`** | Read-only tree position prepared by a worker lease before server acceptance. |
| **`Terminal acknowledgement`** | The final bounded turn executed after an accepted outcome tool to return results and complete worker execution cleanly. |

---

## 2. Agent Tools & Interactive Q&A

| Term | Definition |
|---|---|
| **Agent Tool** | Any capability exposed to an AI agent during a turn (built-in primitives, integration tools, interactive tools, or outcome tools). |
| **Built-in Primitives** | Core workspace tools (`read`, `bash`, `edit`, `write`) that control filesystem and shell interaction. |
| **Integration Tools** | Extension-provided tools for interacting with external services. |
| **Outcome Tool** | Terminal tool declared on an LLM turn that returns typed data, publishes markdown, and triggers process state transitions. |
| **`ask_questions`** | Interactive tool enabling agents to pause execution and ask human operators structured multiple-choice questions mid-turn. |
| **Question Request** | Durable pause inside an active LLM turn created by `ask_questions`, awaiting structured operator answers without resetting context. |

---

## 3. Instance Tree & Workspace Architecture

| Term | Definition |
|---|---|
| **Instance Tree** | Persisted JSONL file (`<instanceId>.jsonl`) backing the Pi-driven execution lineage and turn entries of a process instance. |
| **Leaf Pointer** | Pointer referencing the active entry in the instance tree. |
| **Primary Path** | Operator-facing main execution branch extending from the top-level entry to the active leaf pointer. |
| **Root Branch** | Branch whose first entry is appended at the session root with `parentId: null`. |
| **Review Branch** | Side branch forked for code review or analysis that can merge back into the primary path upon completion. |
| **Pi Resource Snapshot** | Immutable, content-addressed non-secret package containing settings, models, extensions, skills, and prompts for worker materialization. |
| **Workspace Clone** | Dedicated full Git repository clone checked out to a specific work branch (`feat/...`). |

---

## 4. Browser UI & Chronicle

| Term | Definition |
|---|---|
| **Chronicle** | Main process timeline pane rendering streaming agent reasoning, tool execution logs, and published markdown products. |
| **Turn Rail** | Right-hand navigation rail displaying the process outline, turn execution states, active leaf, and future turns. |
| **Product** | Named markdown result published by a turn (e.g., `plan`, `review`) and consumed by subsequent turns. |
| **Product Ref** | Durable pointer linking a published product name to its source turn record. |
| **FIFO Input Queue** | Monotonically sequenced queue of text steering instructions submitted by operators and consumed sequentially by workers. |

---

## 5. Skills & Catalog

| Term | Definition |
|---|---|
| **Installed Skill** | Skill revision imported into SQLite with an active status available for future process launch selection. |
| **Attached Skill** | Immutable skill revision explicitly pinned to a process instance during launch creation. |
| **Skill Candidate** | Discovered skill revision in a configured Git repository that is available for installation. |
| **Skill Invocation** | Execution event recorded when an assistant explicitly reads a skill's root `SKILL.md` during a turn. |

---

## 6. Deprecated Terms & Anti-Patterns

| Avoid | Use Instead | Reason |
|---|---|---|
| *Agent instance* | **Process instance** | Distinguishes background agent execution from durable process state. |
| *Command service* | **ProcessEngine** | Reflects the core architectural component name. |
| *Detail pane* | **Chronicle** | Standardizes UI timeline naming. |
| *Detail rail* | **Turn Rail** | Standardizes UI navigation rail naming. |
| *Future step* | **Future turn** | Aligns with the turn-based paradigm. |
| *Task* | **Turn** | Avoids confusion with background operational tasks or sub-tasks. |
| *Task run* | **Turn record** | Accurately describes durable execution attempts. |
