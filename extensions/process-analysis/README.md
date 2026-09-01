# Process Analysis

`@leitwerk-dev/process-analysis` adds a UI launcher for read-only analysis of an existing leitwerk process.

## Launcher fields

- **Process id or URL**: a plain process id, `/processes/:id`, `/api/processes/:id`, or full HTTP(S) URL. URL inputs are used only to extract the process id; snapshots are always requested from the current leitwerk server. The launcher offers up to five recently used safe process references while still accepting another value.
- **What to analyze**: the operator instruction for the analysis.

Unsupported protocols, credentials in URLs, missing ids, and empty instructions are rejected. Credential-bearing URLs are not remembered.

## Process

The process has two business turns:

| Turn | Kind | Purpose |
|---|---|---|
| `analyze_process` | LLM | Prepare a current snapshot, then analyze it read-only. |
| `analysis_decision` | Human | Complete, refine, ask a follow-up, or refresh and rerun the analysis. |

## Snapshot behavior

The preparation phase of `analyze_process` calls the authorized `process_analysis_download_snapshot` integration tool before Pi is prompted. It reports **Analysis preparation** progress in the same Chronicle cluster and does not create a separate Turn Rail entry. The server-owned tool downloads `/api/processes/:id` and `/api/processes/:id/primary-path`, then writes:

- `process-detail.json`
- `primary-path.json`
- `summary.md`
- `turn-records.md`
- `events.md`
- `chronicle.md`

Snapshots are stored below the target process workspace at `.leitwerk/process-analysis/<analysisProcessId>/`. Snapshot metadata also records the server launch directory as the analysis directory.

## Tool policy

The analysis LLM turn has only `read` and `bash`. It runs in the absolute directory where the Leitwerk server was launched. Its prompt requires read-only inspection, prohibits file modifications, and directs any code/repository inspection to that server launch directory only. Process Analysis does not require any configured `components` entry.

## Follow-up

From the decision turn, the operator can complete the analysis, ask follow-up questions, refine the analysis, or refresh the snapshot. Refresh routes back to `analyze_process`; its preparation phase replaces the snapshot before the next prompt. Completion retains the latest analysis product. Process Analysis does not launch repository-change processes or create tracker tickets.
