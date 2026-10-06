# Stop at the next safe boundary

An operator may want useful work to finish while retaining a chance to inspect it before automatic publication. This throwaway prototype asks: **Can operators express a precise hold intention without understanding the process graph?**

Open `index.html` directly in a browser. The file contains all markup, styles, fixtures, and JavaScript. It requires no server, installation, network, or credentials. Reset restores the synthetic process; closing the page discards its in-memory state.

This is a future proposal, not an available Leitwerk control. Unlike the prior prototype batch, its intervention is a hold between automatic steps: it lets accepted work finish, names the successor that will be blocked, and distinguishes a missed boundary from a successfully prevented acceptance. It is not a review checkpoint, queue annotation, abrupt interruption, or recovery shortcut.

## Actions

Choose **Hold before publication** or **Hold after this turn**, keep a review-note draft, and request the hold. The timeline shows accepted work, the requested boundary, the boundary actually reached, and an explicit release. A reached hold permits inspection, Resume, or Abort. Resume requires the current retained result to have been inspected. This review prerequisite is an experimental policy, not an existing core rule.

The free-play fixture can finish accepted work, accept publication before a request, replace a saved result, or toggle result availability. Requesting a hold with stale facts is refused until the operator refreshes them. Draft notes and boundary selection survive updates and refusals. Withdrawing a requested hold does not interrupt work. Stopping work has a separate inline confirmation and parks the selected turn in error. An abort at a reached hold ends the workflow without undoing publication.

All numbers come from the synthetic state. Every worker turn in this shortened fixture has one accepted attempt. A hold adds no attempt. The result version belongs to the saved fixture result, and an inspection remains visibly stale when that version changes.

## Walkthroughs

1. **Before publication:** request the hold, finish editing, finish preparation, inspect the saved result, and Resume. Publication is accepted only after release.
2. **The boundary was missed:** publication is accepted first; the original hold request receives `boundary-passed`. Explicitly choose the later boundary, finish publication, inspect it, then Abort. The recorded publication remains visible.
3. **The result changed:** hold after the editing turn, inspect its result, replace the saved version, and try Resume. Only `result-changed` advances this expected-refusal step. Inspect the new version and release the hold.

Guided steps use the same pure reducer as the free-play controls. Success must come from the intended action; refusal steps require their exact reason code. Interleaving a conflicting free-play action leaves the guide at its current step, with a reset hint.

## Integration seams

These paths exist in the base repository:

- `extensions/coding/src/repository-change-process.ts` composes the authored repository-change workflow and explicitly describes automatic publication after implementation. A future process-owned boundary declaration would belong with that code-defined graph.
- `extensions/coding/src/repository-change-publication.ts` performs publication and records delivery evidence. A held successor must not call publication prematurely; release must retain the existing external-write idempotency contract through `ensureWrite()` in the owning integrations.
- `packages/server/src/process-engine/ops/accept-worker-turn-start.ts` validates the current reservation, lease, selected turn, and acceptance identity before creating an attempt. A future hold must be enforced under exclusive server coordination before successor acceptance, rather than trusting a browser flag.
- `packages/server/src/process-engine/ops/deferred-process-activation.ts` demonstrates expected-fact comparisons, stale outcomes, and server-owned activation writes. It handles deferred activation today; it does not implement operator holds.
- `packages/domain/src/domain-model.ts` defines the existing lifecycle statuses. Hold intent requires a separate proposed field; the prototype adds no `waiting_for_input` or `held` lifecycle status.
- `docs/server-worker-lifecycle.md` specifies reserved starts, accepted attempts, correlated outcomes, and cancellation limits. `docs/ui.md`, “Questions and actions,” requires stable action drafts and contextual controls.

## Proposed contract additions

A server-owned hold intent would record the code-declared boundary, requesting actor, expected process revision, original accepted turn identity, and eventual reached/released outcome. The server would arbitrate hold requests and successor acceptance under the same process lock. If acceptance wins, it must report that the requested boundary was missed and identify a later reachable boundary; it must never claim to have prevented the accepted work.

Reaching the boundary would retain the completed result and the intended successor while withholding acceptance. A release would compare the reviewed result identity and revision under that lock. This experiment keeps lifecycle `active` while the separate hold is reached; its exact scheduler, reservation, lease cleanup, restart, and persistence semantics require a production design and explicit schema migration. Config must not manufacture process graph gates.

Abort, interruption, hold, and external-write outcome remain separate facts. The UI cannot infer a completed publication from absent evidence or promise that cancellation reverses an external write.

## Validation and limits

Observed validation:

- Real browser clicks completed all three guides and the free-play path from a stale request through a reached hold to explicit publication acceptance.
- Notes survived unrelated updates and refusals. Missing inspection, stale inspection, and unavailable result bodies blocked Resume. Restoring a body required a fresh inspection.
- Withdrawing a second requested hold left accepted work running. Interruption required its own confirmation, preserved the selected turn, and parked the process in error.
- Wrong `not-held` and `not-running` refusals did not advance guide steps expecting `result-changed` and `boundary-passed`.
- Desktop 1440px and mobile 390px captures were opened and visually inspected. Mobile Resume worked and retained the note; document width was 390px with no horizontal overflow. All visible buttons measured at least 44px high. Browser error output was empty.
- Biome, extracted inline JavaScript `node --check`, and `git diff --check` passed. The design detector reported no regex findings in degraded mode: HTML parser dependencies were unavailable, so computed contrast, custom-property resolution, and selector matching were not evaluated.

Application `test:full` was not run. All changes are confined to this standalone prototype artifact, outside application build and runtime paths.

The process is a shortened synthetic sequence, not the actual complete repository-change graph. The race is deterministic; there is no concurrent worker, database, restart recovery, provider, authorization, or real publication. Replacing a result and restoring retention are fixture controls. The experiment does not establish production safety or user-study findings.

Provisional learning: naming both what may continue and what is withheld makes the hold intention understandable without graph terminology. The acceptance race needs its own outcome and a deliberate choice of the later boundary. Inspection must remain visibly bound to the saved version if release is meant to represent an informed decision.
