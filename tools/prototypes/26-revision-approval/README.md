# Approve the revision I reviewed

Throwaway operator prototype. Open `index.html` directly in a browser; no server,
dependencies, network or real process is needed. All fixtures and notes live in
memory and reset on reload. The screenshots show the actual local browser.

The operator has read a plan and prepared a decision, but the plan, destination
or action conditions change before approval. The design question is: **Can an
operator recognize which changes invalidate a prepared decision without rereading
unchanged evidence?**

This adds a reviewed boundary to an individual decision. Unlike the earlier
operator experiment batch's review packets or hypothetical outcome comparisons,
it experiments with stale consent: the exact evidence the person reviewed must
still be the evidence accepted when the request is applied.

## What to try

The plan is a reading document. Its reviewed receipt is alongside it on desktop
and below it on mobile. The prepared decision stays attached to the document.

- Mark the displayed plan, destination and action condition reviewed.
- Type a private review note. It is local metadata, not a process instruction.
- Approve the reviewed plan, then choose **Accept pending request** in the fixture
  controls. This pause makes competing updates observable.
- Publish a new plan, change only the destination or change only an action
  condition. The old reading copy and receipt remain visible; approval changes to
  **Review changed conditions**.
- Compare old and captured current conditions, then explicitly adopt the new
  boundary. Opening or refreshing the comparison never adopts it.
- Change conditions again while comparing. The captured comparison becomes stale
  and adoption is disabled until refreshed.
- Simulate a colleague taking the action, remove retained plan evidence, or
  attempt the prepared approval directly. The model refuses obsolete requests
  and preserves the note.
- Send a valid request and change conditions before accepting it. Acceptance
  checks the original reviewed snapshot, even if the same action still exists.
- **Reset free play** restores the initial synthetic process and clears local
  notes. Selecting a guided scenario also starts from its initial fixture.

The three guided scenarios perform real model actions and advance only after the
expected result and fixture conditions are observed:

1. **Reviewed approval:** review Plan 1, prepare a note, receive an unrelated
   update, send and accept. The unrelated update preserves the review boundary.
2. **Changed conditions:** prepare an approval, publish Plan 2 and change the
   destination. Observe refusal of the old approval, compare and adopt, then
   approve Plan 2.
3. **A colleague acts first:** send a reviewed request, let the colleague take the
   action, then observe rejection at acceptance. Implementation is already
   selected; the local request was never applied.

## Model and proposed contract

`ApprovalModel` is a pure reducer over synthetic state; DOM rendering and event
handlers live below it. It keeps the current context, reading copy, reviewed
snapshot, captured comparison, pending request, accepted receipt and local note
separate. The snapshot includes immutable result/turn identities, full fixture
content, destination, action identity and condition revision, selected turn,
action availability and retained-evidence availability. Unrelated activity does
not invalidate it. Returning a destination to its previous text still changes the
condition revision, avoiding reuse of earlier consent after intervening changes.

A proposed server request would carry a server-issued reviewed-boundary token or
typed precondition for the exact product/semantic result and owning turn record,
alongside the destination and action conditions. The authoritative server must
load and compare those facts under its per-process exclusive coordination,
before recording the decision and releasing side effects. An opaque token must
resolve to server-owned facts; client-supplied document text cannot authorize an
approval. A conflict response should identify the current decision and exact
changed conditions so the UI can preserve the old draft and compare them.

This precondition is **not implemented by this prototype or already supplied by
`ProcessInstance.planRevision`**. The existing counter is useful plan metadata;
it alone does not identify an exact reviewed result or cover destination/action
changes. In this experiment, action-condition changes can invalidate consent
while the plan version stays unchanged. Production references should use retained
immutable product/semantic entry identities rather than copied display strings.

An accepted human action selects Implementation in the fixture. The prototype
does not start a worker, create an execution attempt, advance worker acceptance
or write to an external service. A production implementation must preserve the
existing worker acceptance/turn-record correlation and `ensureWrite()` rules.
Persisting review receipts or private notes would require an explicit schema
migration; this experiment adds no storage or lifecycle state.

## Verified integration seams

| Existing source | Observed behavior and proposed addition |
| --- | --- |
| `extensions/coding/src/repository-change-process.ts` | `plan_decision` reviews semantic `plan`; its approval checks for a semantic turn record and emits `plan_approved` with the current `planRevision`. `plan_saved` increments that counter. Bind future consent to the actual reviewed result as well as action conditions. |
| `packages/ui/src/pages/process-detail/process-detail-action-drafts.svelte.ts` | Keeps action-keyed form drafts and a shared primary prompt. A reviewed receipt should accompany the draft without resets on unrelated refreshes or conflicts. The private note in this prototype is an additional proposal. |
| `packages/server/src/process-action-planner.ts` | Validates input and resolves current visible/turn-scoped actions. Current action visibility alone cannot prove that the operator reviewed the same artifact. |
| `packages/server/src/routes/process-actions.ts` | Parses the action request and delegates to `futureExecutionLifecycle.scheduleAction`. A new precondition must survive request parsing and dispatch; this prototype changes no route. |
| `packages/server/src/future-execution/lifecycle.ts` | Owns immediate/scheduled action handling and coordination for scheduled mutation. Any future delayed approval support needs defined revalidation semantics at execution, not only when scheduled. Scheduling is outside this experiment. |
| `packages/server/src/process-engine/runner.ts` | Serializes decision through durable recording with `processOperations.runExclusive`, then dispatches reactions after release. Final precondition validation belongs within this authoritative boundary. |

## Validation and learning

Observed validation:

- Biome check passes; every button declares its type. Extracted inline JavaScript
  passes `node --check`; `git diff --check` passes.
- All three guided scenarios completed through browser clicks, with actual model
  outcomes asserted. The first retained its review after an unrelated update;
  the second rejected old consent and accepted explicitly adopted Plan 2; the
  third refused a duplicate action after the colleague acted.
- Free play used real typing and clicks. The typed note survived an unrelated
  update, stale submission refusal, stale comparison and acceptance-time plan
  replacement. A condition-only update invalidated consent with Plan 1 unchanged.
  Missing evidence blocked adoption. A normal free-play approval succeeded.
- At 390px, adopting and approving the comparison succeeded with the note intact.
  Desktop document width was 1440px and mobile width 390px, matching their
  viewports. No horizontal overflow, buttons shorter than 44px or browser errors
  were observed. Both full-page screenshots were opened and visually inspected.
- The Impeccable detector ran once and returned no findings in **degraded regex
  mode** because its HTML parser modules were unavailable. It did not evaluate
  computed contrast, custom properties or selector matching; this is not a
  complete automated accessibility audit.

No application code, shared contracts, application dependencies or build
configuration are changed; `npm run test:full` is intentionally outside the
standalone-helper policy. No automated test suite was added.

Provisional learning: a version number is insufficient feedback when the plan is
unchanged but its destination or action condition changes. Keeping the previous
receipt beside a captured comparison makes the scope of renewed consent visible.
The interface also needs a pending request boundary: client freshness at the
moment of clicking cannot settle a later acceptance race. This is a design
hypothesis demonstrated by fixtures, not a user-research result.

Limits: one process, synthetic identities, no authentication, durable notes,
WebSocket updates, server coordination, real retention, scheduled decisions or
external writes. The synthetic plan text remains locally available after evidence
removal and is explicitly labelled historical; production retention/redaction
rules must decide what local snapshots may retain. No access control or new
terminal state is proposed. Public Sans uses the installed face when available
and the system sans fallback otherwise, keeping the file self-contained.

Screenshots: [Desktop](screenshots/desktop.png) · [Mobile](screenshots/mobile.png).
They are browser captures of this synthetic prototype, not generated imagery.
