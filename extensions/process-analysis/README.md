# Process Analysis

`@leitwerk-dev/process-analysis` adds a UI launcher for read-only analysis of an existing leitwerk process.

## Launcher fields

- **Process id or URL**: a plain process id, `/processes/:id`, `/api/processes/:id`, or full HTTP(S) URL. URL inputs are used only to extract the process id; snapshots are always requested from the current leitwerk server. The launcher offers up to five recently used safe process references while still accepting another value.
- **What to analyze**: the operator instruction for the analysis.

Unsupported protocols, credentials in URLs, missing ids, and empty instructions are rejected. Credential-bearing URLs are not remembered.

## Snapshot behavior

The first server turn downloads `/api/processes/:id` and `/api/processes/:id/primary-path`, then writes:

- `process-detail.json`
- `primary-path.json`
- `summary.md`
- `turn-records.md`
- `events.md`
- `chronicle.md`

Snapshots are stored below the target process workspace at `.leitwerk/process-analysis/<analysisProcessId>/`. Snapshot metadata also records the server launch directory as the analysis directory.

## Tool policy

The analysis LLM turn has only `read` and `bash`. It runs in the absolute directory where the Leitwerk server was launched. Its prompt requires read-only inspection, prohibits file modifications, and directs any code/repository inspection to that server launch directory only. Process Analysis does not require any configured `components` entry.

## Follow-up and handoff

From the decision turn, the operator can complete the analysis, ask follow-up questions, refine/rerun analysis, or refresh the snapshot. When Local Repo Change is also loaded, its launch-planner capability adds the action and turn for starting a Local Repo Change process. Without that optional capability, neither is present in the process graph.

Handoff targets the same server launch directory as a local repository, derives its base branch from that repository when possible (falling back to `main`), leaves the work branch blank for automatic selection, and asks the Local Repo Change planner for an explicit `imported_plan` launch. The analysis is imported as a hidden plan, and implementation starts after Local Repo Change creates the automatic work branch and replans its entry turn. If the server launch directory is not a git repository, that error is reported only when starting the handoff.

Process Analysis keeps its source provenance in opaque target-process metadata and owns the durable deduplication key (`process-analysis:<analysisProcessId>:local-repo-change`). Retrying or concurrently triggering the same handoff therefore reuses the same Local Repo Change process instead of creating duplicates. A successful create or reuse completes Process Analysis and runs its normal snapshot cleanup. An unsuccessful handoff leaves the failed turn available for retry.
