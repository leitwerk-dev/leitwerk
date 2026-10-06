# Decision rounds

A throwaway operator experiment: **Can a bounded decision round reduce navigation effort without encouraging approval by rote or hiding context?**

An operator reviewing several processes loses their place and unfinished feedback when opening them separately. This prototype captures a stable itinerary, presents one recorded result beside its individual action, and preserves drafts across navigation. It is a future proposal with synthetic, in-memory fixtures. It has no production integration.

## Open

Double-click `index.html`, or open it in a browser. No installation, server, network, or credentials are needed. Reset and reload discard all round state and drafts.

## Try it

Start a round with the three waiting decisions. Read the result, choose an action, type any required text, confirm the reviewed revision, and submit. Submission affects only that synthetic process. **Done and next** acknowledges the slot after its decision resolves; **Leave for later** preserves unfinished work; **Next process** only navigates. None of these navigation controls submits a decision.

Drafts are keyed by process and action. Switch actions and processes to retrieve their separate drafts. After resolution, the retained-action selector and **Select draft to copy** keep all text accessible. The copy control selects the text for the browser's standard Copy command; it does not claim to write the clipboard.

Fixture controls can introduce one new decision or simulate Mara resolving the selected decision. Arrivals remain outside the round until explicitly appended. A colleague-resolved slot stays in place, labels the original result historical, preserves drafts, and refuses submission against the unavailable action. The accepted decision records its reviewed revision and explains the possible next step; it does not claim successor work ran.

## Guided walkthroughs

Each walkthrough resets the fixtures and exposes a real action button for each step. Steps advance only after the expected transition or the specifically expected stale-action refusal.

1. **Finish one decision:** capture the waiting set, review the gateway plan, approve that plan, and mark its slot Done. The other decisions remain open.
2. **Keep a draft:** prepare requested plan changes, leave them for later, simulate and admit a new arrival, then return to the original text. The arrival appends without changing the selected process or earlier positions.
3. **A colleague acts:** prepare a note, review its result, simulate Mara resolving the decision, attempt the prepared action, and acknowledge the resolved slot. The attempt is refused and its draft survives.

Free play also supports required-field and missing-review refusals, repeat inspection of historical results, round completion, and returning to acknowledged slots. On mobile, the itinerary collapses above the reading surface and its summary retains the new-arrival count.

## Novelty

This is a sequential task workspace, not a digest, attention ranking, or batch approval. Compared with the prior prototype batch's review and attention ideas, its distinct object is a bounded ordered round with per-process draft continuity. The neighboring operator work desk explores stable supervision membership; this experiment focuses on finishing individual decisions while preserving an operator's place.

## Integration seams

These paths exist in the repository at the prototype's base commit:

- `packages/server/src/process-action-presenter.ts`: `listVisibleActionsForProcess` and `buildActionSummaryForProcess` project current actions, form fields, and previews.
- `packages/protocol/src/http-contracts.ts`: `ProcessActionSummary` describes each individual available action.
- `packages/ui/src/pages/process-detail/ProcessDetailChronicle.svelte` and `packages/ui/src/chronicle/components/ChronicleActionSection.svelte`: retain the canonical result and detailed action surface in a production implementation. This standalone page only illustrates that relationship.
- `packages/ui/src/pages/process-detail/process-detail-action-drafts.svelte.ts`: current drafts are action-keyed within the detail controller. A round would lift that state into a process-and-action keyed workspace store, including the shared primary prompt, schedule, and model options.
- `packages/server/src/routes/process-actions.ts`: existing individual action submission route `/api/processes/:instanceId/actions/:actionId` remains authoritative.
- `packages/server/src/routes/process-questions.ts`: questions use `/api/processes/:instanceId/question-requests/:requestId/answers`. Answering resumes the current turn; it does not create another attempt.

## Proposed contracts and limits

Round membership, order, and Done/Later markers are presentation metadata. Cross-device persistence would require an explicit operator preference contract and a migration if stored durably. This experiment deliberately keeps those values in memory.

Availability must be revalidated under existing server process coordination. Binding consent to a reviewed result or plan revision needs an explicit server precondition; the prototype's pure reducer illustrates that check, without claiming the existing action route already accepts it. It preserves a decision receipt after a simulated acceptance but does not model worker startup, turn-record acceptance, or external writes.

The prototype includes three starting decisions and one arrival, abbreviated results, simple text forms, and a single simulated colleague. It omits scheduling, model overrides, arbitrary form schemas, evidence removal, reconnects, and production permissions. It neither changes lifecycle through navigation nor adds batch actions. A future integration must preserve the current canonical forms and server-owned lifecycle. Any external effect continues through its existing idempotent integration path.

## Observed validation

- Biome HTML check passed; extracted inline scripts passed `node --check`; `git diff --check` passed.
- All three guided walkthroughs completed through browser clicks.
- Free play exercised typed individual approval; missing-review and required-text refusals; switching process and action drafts; Later plus new arrival admission; stale submission refusal; persistent historical labeling after returning; and selection of retained drafts for copying.
- At 390px, itinerary navigation, typed feedback, refusal of Done on an unresolved decision, and restoration of another process's draft passed. Desktop and mobile reported no horizontal overflow or browser errors.
- Actual 1440px desktop and 390px mobile screenshots were captured and visually opened. They show the full reading and action flow.
- The Impeccable detector ran once and returned no regex findings in **degraded mode** because its parser modules were unavailable. Computed contrast and selector analysis were not evaluated by that tool.

No application code or runtime configuration changed. Scoped helper validation applies; the application full suite was not run.

## Provisional learning

The stable itinerary and append-only arrivals keep identity and position legible while individual decisions change. Draft retention remains useful after an action becomes unavailable, so resolved slots need an explicit read-and-copy path. Separating submission from Done makes the navigation boundary visible, at the cost of one additional acknowledgement. Operator research is still needed to determine whether that extra step prevents rote approval or simply adds friction.

Screenshots: [desktop](screenshots/desktop.png) · [mobile](screenshots/mobile.png).
