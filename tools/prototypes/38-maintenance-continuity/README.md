# Maintenance continuity sheet

An operator can capture the accepted work, queued starts, and external waits before maintenance, then account for the same processes after reconnect. The experiment asks: **Can an operator account for every in-flight process without interpreting normal worker replacement as lost work?**

This is a future UI proposal with synthetic, in-memory fixtures. Open `index.html` directly in a browser; no installation, server, network, or framework is required. The selected runner applies to the whole synthetic installation. Resume on boot is enabled in both fixtures; observed recovery is not a guarantee.

Unlike the earlier worker-chaos experiment, this sheet supports a planned maintenance interval. A frozen inventory stays in place while adoption, replacement, queue acceptance, and terminal acknowledgements arrive. It does not perform maintenance, add a drain switch, deploy software, or recover processes.

## Interactions

- Capture one immutable before sheet, cross a simulated connection boundary, and compare all four retained process identities.
- Choose an isolated Kubernetes or local installation before capture. Local shutdown stops workers; isolated shutdown detaches them. The local fixture subsequently observes replacement against the same accepted record and attempt.
- Inspect each synthetic Chronicle preview. Record a draft or save an operator note locally. Notes survive selection changes, observation updates, and refusals within the tab. Reload, Reset, or a new guide clears the experiment.
- Observe a terminal report, correlated replay, then durable acknowledgement separately. Pending terminal evidence remains unresolved until recording is acknowledged. The release-notes fixture has a final turn, so recorded terminal success also completes that fixture process.
- Observe the queued start's first server acceptance. Its frozen reservation stays distinct from the newly executed attempt; repeated acceptance refuses instead of incrementing the attempt again.
- Mark an observation reviewed, recheck stale evidence, or simulate unavailable evidence. Review marks are operator metadata; they never change lifecycle or promise continuity.

Controls remain available to expose their refusal reasons. A frozen checkpoint cannot be overwritten or switched to another runner. Comparison requires capture and reconnect; terminal recording requires the matching pending replay; a stopped local worker cannot finish during the outage. Stale, unavailable, or unacknowledged terminal evidence cannot be reviewed. Unavailable evidence remains unresolved after inspection or recheck. Drafts survive these refusals.

## Walkthroughs

1. **Local replacement:** capture, disconnect, observe replacement, inspect the accepted execution, and review it. The original turn record and attempt remain; the physical worker identity changes.
2. **Late terminal acknowledgement:** capture an isolated installation, disconnect, and simulate a worker reporting completion. Reconnect and try to review before recording, then again after replay. Both refuse. Observe durable acknowledgement, then review the recorded completion.
3. **Stale review refusal:** capture, reconnect, and inspect the queued start. Make evidence stale and try to review it. Recheck, then review fresh queue evidence. A stale indicator does not disappear merely because the process was opened.

Each guide inspects its named process. Later row actions require that same selection: Refresh checkout policy for Local replacement, Build release notes for Late terminal acknowledgement, and Scan compatibility for Stale review refusal. Selecting another row refuses before any guided mutation or progression; all notes and drafts remain. Return to the named row to continue. Refusal steps require its exact stale or reported/replayed terminal state as well as the expected refusal code. Capture, disconnect, reconnect, and terminal observations retain their global fixture scope. Other incompatible free-play changes can leave the next step refused; restart that guide to recover its known fixture.

## Integration seams

These are existing source seams, not integrations implemented by this HTML:

- `docs/server-worker-lifecycle.md`: start reservation versus accepted attempt; local stop versus isolated detach; readiness, adoption, acceptance replay, and terminal recording acknowledgements.
- `packages/server/src/app.ts`: `stopAcquiredWorkers` calls `shutdownAll("server_shutdown")` for local runners and `detachAll("server_shutdown")` for isolated runners.
- `packages/server/src/supervisor/worker-supervisor.ts`: acceptance replay, adoption coordination, local worker shutdown, and `worker.turn_terminal_recorded` publication.
- `packages/server/src/process-engine/startup-reconciliation.ts`: reconciliation of retained active starts under `resume_on_boot`.
- `packages/server/src/supervisor/adoption/adoption-plan.ts`: physical descriptor classification against retained process, lease, worker identity, and model policy. A matching pod alone is insufficient evidence of adopted work.
- `packages/server/src/routes/process-detail.ts`: the existing `/api/processes/:instanceId/ui-snapshot` route provides process/startup evidence.
- `packages/server/src/process-ui-snapshot-presenter.ts`: existing process snapshot assembly.
- `packages/ui/src/pages/process-detail/ProcessDetailChronicle.svelte`: the canonical destination for future process links and recovery controls. This standalone artifact opens a synthetic preview in place of navigating a real installation.

A production version needs a bounded read projection correlating checkpoint rows with current execution, lease, start, listener, and terminal-record evidence. Persisted maintenance checkpoints, notes, and review receipts would be new server-owned metadata requiring an explicit migration and revision conflict rules. Receipts must bind to the observation reviewed. A missing or delayed observation cannot establish failure or success. Maintenance actions, automatic recovery, scheduler changes, permissions, and cross-installation aggregation are outside this proposal.

## Validation and limits

Validation details below record actual checks on the standalone artifact. Application `test:full` is not required under the standalone-helper policy; no application code, dependency, build, runtime configuration, or shared documentation changes are included.

- Biome checked the HTML; inline JavaScript passed `node --check`.
- The Impeccable detector returned no regex findings in degraded mode because HTML parser dependencies are unavailable. It did not evaluate computed contrast or selector matching.
- All three browser guides completed again after the subject fix (23 steps). Before every row-scoped step, selecting another process refused without mutation or progression and preserved both drafts. The original checkout-selection repro remained at the queued step through four next-step clicks. Fresh queued evidence and a replayed terminal could not substitute for the expected stale and reported-terminal refusals.
- Free-play verified notes surviving selection/reconnect/refusals; stale evidence surviving inspection; unavailable evidence remaining unresolved; no duplicate accepted attempt; immutable capture and runner; unexpected guide refusal retaining its step; and offline local-worker finish refusal.
- Desktop (1440px) and mobile (390px) full-page screenshots were refreshed after the subject fix, opened, and visually inspected. Both widths had no horizontal overflow; the browser reported no errors. The screenshots show a terminal replay still awaiting durable acknowledgement.
- `git diff --check` passed.

The data is invented, not a production operational record. No real worker, acknowledgement, external wait, database, or lifecycle is mutated. Notes are intentionally in-memory. Observation numbers are fixture counters, not production timestamps or ordering guarantees. The prototype reduces a production terminal mutation and acknowledgement into one observed event; it is not an IPC implementation.

Provisional learning: the physical-worker change must be secondary to the accepted execution identity. A visible unresolved row is more useful than an optimistic reconciliation checkbox while terminal recording is pending. This is a model-level finding from walkthroughs, not evidence from operator research.
