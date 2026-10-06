# Know what stopping will leave behind

An operator who stops a publishing turn needs to distinguish interruption from rollback. This throwaway prototype asks: **can a concise confirmation prevent that confusion while remaining quick to use under pressure?**

This is operator idea 30 in the second batch. Its novelty is an intervention-time inventory and receipt: committed effects, uncertain provider writes, open approvals, and independently continuing result-derived processes appear together. It explores the consequences of stopping, rather than a general process dashboard, notification digest, or authoring tool.

## Open

Double-click `index.html`, or open it through a `file://` URL. Everything is inline HTML, CSS, and JavaScript. No installation, server, network, credentials, or production data are needed. Reloading clears all state.

## Try it

The current process, selected turn, accepted turn record, attempt, and lifecycle remain visible. The effect inventory shows its latest observation boundary. **Review stop this turn** and **Review abort process** open inline confirmations. A local optional note survives unrelated updates, refused commands, review refresh, and closing/reopening the review.

The three guided tabs reset the fixture and start a fresh draft:

1. **Stop, then wait for confirmation:** review the turn, request its interruption, and simulate the worker confirmation. Acceptance leaves lifecycle `active`; confirmation parks the failed turn at lifecycle `error`. Selected turn and attempt remain unchanged. Committed effects remain, and the unresolved write remains uncertain.
2. **A write commits during review:** open an abort review at evidence 18, receive the pull-request commitment at evidence 19, then confirm abort. The frozen review stays visibly stale. The receipt retains both boundaries and names pull request #286 as committed at acceptance. The independent issue draft continues.
3. **Worker disappears before stop:** open a stop review, optionally type a note, make the worker unavailable, then try stopping. The command is refused with `worker_unavailable`, the process stays active, and the draft remains. Restore the connection or review process abort to continue free play.

Each guided step advances only on its expected success or exact expected refusal. Free-play fixture buttons can also restore the worker, remove the supervisor, complete the process elsewhere, deliver a late write, and confirm an accepted interruption. Reset starts over. These are explicitly simulated outside events, not commands sent to any service.

## Existing integration seams

Paths below are relative to the repository root and were inspected at base `050a860b016a00db2eab6ceec31bf21885a6165f`.

- `packages/ui/src/pages/process-detail/process-detail-actions.svelte.ts`: `abortRunningTurn` calls `postProcessAbortTurn`, then reloads while the worker reports failure asynchronously.
- `packages/server/src/process-engine/ops/abort-turn.ts`: `AbortTurn` checks the supervisor first, then active lifecycle and a running LLM turn, then worker availability. Refusal codes are `worker_supervisor_unavailable`, `invalid_transition`, and `worker_unavailable`. Acceptance appends `turn_abort_requested` and requests a worker interruption; it does not synchronously park the process.
- `packages/ui/src/components/ProcessActionsMenu.svelte`: existing process-abort confirmation and action entry point.
- `packages/server/src/process-engine/ops/abort-process.ts`: process abort validates lifecycle, runs cleanup, builds durable abort writes, and cancels scheduled actions. Its optional expected-turn guard and cleanup failures remain part of the real operation.
- `extensions/coding/src/repository-change-publication.ts`: `PublicationState` records `headSha`, pull-request identity, delivery progress, and pending evidence. An extension-owned projection could summarize this without core importing extension types.
- `docs/agent-tools.md`: committed provider writes cannot be rolled back by cancellation; approvals belong to an accepted turn and are cancelled when that turn ends. External-write reconciliation must preserve `ensureWrite()` identity and idempotency.
- `docs/operator-guide.md`: stop interrupts execution, abort ends the workflow, and a separately created issue draft continues when its parent is stopped.

## Proposed additions

The impact projection, stale-review presentation, optional note, and acceptance receipt are future proposals. There is no existing impact API implied by this file.

A production projection would need a typed, read-only inventory containing evidence sequence, accepted turn-record identity, provider evidence references, observation age/completeness, open approvals, and separately derived process references. Unknown evidence must stay unknown until the provider is reconciled. Extension adapters would own provider-specific summaries.

Acceptance would still use the server's exclusive per-process coordination and current-state validation. A receipt should preserve the reviewed boundary and the latest observed boundary at command acceptance, while keeping worker acknowledgement separate. The prototype permits a stale impact review to submit after revalidation; it shows both boundaries and the changed effects. Whether a material scope change should require a renewed confirmation needs operator research. No atomic rollback or exhaustive remote audit is promised.

The existing turn-stop input does not carry the prototype's review sequence or note. Those contracts, stale-turn handling, durable receipts, authenticated attribution, and any receipt storage migration need deliberate design before integration. Notes would be operator metadata, not a lifecycle transition. This proposal adds no authorization or tenant boundary and does not create processes automatically.

## Observed validation

- Biome checked the standalone HTML with no findings after the final fixes. All buttons, including generated markup, declare `type="button"`.
- Every inline script was extracted and passed `node --check`; `git diff --check` passed.
- Agent Browser exercised all three guided cases with real clicks and typing. The stop case stayed active at acceptance and reached `error` only on confirmation. The race case retained review 18 and accepted evidence 19 with the newly committed pull request. The refusal case preserved its note and stayed active.
- Free play confirmed a successful stop and acknowledgement, then delivered a late write: the live inventory changed to two committed effects while the acceptance snapshot retained its original uncertain write.
- Additional checks observed `invalid_transition` after external completion and `worker_supervisor_unavailable` taking precedence when the supervisor was also absent. Restoration preserved both the draft and stale-review warning.
- Desktop 1440px and mobile 390px screenshots were captured and visually opened. The 390px document and body widths were both 390px. No browser errors were reported.
- Impeccable's detector ran once on this HTML. It reported no regex findings **in degraded mode** because its parser dependencies were unavailable; computed contrast, selector matching, and custom properties were not evaluated. This is not a complete detector pass.

This standalone helper does not change application code or configuration, so application `test:full` was not run. No test suite was added. The draft is not approved for merge by these local checks.

## Limits and provisional learning

The pure reducer is separate from the DOM shell, but fixtures simplify remote timing, cleanup, scheduled work, retries, and turn correlation. No actual cancellation, provider lookup, automatic reconciliation, persistence, or deployment occurs. The ledger is intentionally bounded evidence, not a claim to enumerate every possible effect. Screenshots show an abort review whose evidence has become stale.

The interaction checks support a provisional design lesson: use separate language for **request accepted**, **interruption confirmed**, and **effects that remain**. A fixed receipt makes late evidence understandable without rewriting what the operator reviewed. Whether the amount of evidence is fast enough during real incidents remains untested with operators.
