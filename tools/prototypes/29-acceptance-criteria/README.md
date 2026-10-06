# Check the request before approving

A standalone operator experiment for reviewing a plan against its original request.
Open `index.html` directly in a browser. No server, dependencies, account, or network
is required. Fixtures and edits live in memory; reload or Reset free play clears them.

The question: can a compact acceptance checklist improve a decision without becoming
a second task tracker?

A polished plan can hide an omitted requirement. This surface keeps the retained
launch request beside three operator-confirmed criteria and exact retained result
sections. Linking evidence does not imply satisfaction. A missing 90-day feasibility
assessment remains an explicit gap until revised or waived with a reason.

## What to try

- Confirm or edit criteria extracted from the original request.
- Read a retained result section and link it to a specific criterion wording version.
- Record Satisfied, Needs work, Not verified, or a reasoned waiver.
- Save a review snapshot without changing the business turn.
- Simulate approval or send unresolved criteria with revision notes.
- Change criterion wording, remove retained evidence, or withdraw offered actions.
- Inspect earlier wording, review snapshots, and simulated decision receipts.

Assessment notes and wording drafts are keyed by criterion. The decision draft
survives selection, inspection, rejected actions, and fixture changes. Editing a
criterion creates another version and invalidates the earlier evidence assessment.
Historical snapshots retain the wording and evidence that were reviewed then.
Unsaved wording must be saved or restored before confirming criteria, saving a
review snapshot, or simulating a business decision; refusal preserves the draft.

## Walkthroughs

**A justified approval:** confirm all three criteria, inspect the CSV and access
sections, mark those two satisfied, and waive the 90-day requirement with an explicit
scope reason. Save the exact review and simulate approval. The selected turn changes
to implementation; this demo creates no worker acceptance or attempt.

**Wording changes mid-review:** verify the CSV criterion and save a snapshot, then
require original timezone offsets. The earlier UTC-only evidence becomes stale.
Attempts to reuse that evidence and the old snapshot are refused. Mark Needs work
and request a revision. Expand history to compare the original and changed wording.

**Missing evidence and waiver:** remove a previously linked source after drafting
revision notes. Satisfaction and an empty waiver are refused. Mark Not verified and
request a revision. The source identity and decision draft survive. Missing evidence
is never treated as success.

Guided refusal steps match a specific refusal code. An unavailable action cannot
accidentally satisfy the step intended to demonstrate an outdated review snapshot.
The same pure reducer powers guided steps and free-play controls.

## Existing seams and proposed additions

These are integration seams, not implemented connections:

- `docs/ui.md`, Results and turn details and Process inspector: results and original
  inputs are read in the Chronicle and inspector; inspecting retains action drafts.
- `packages/domain/src/domain-model.ts`: `ProcessInstance.paramsJson` carries launch
  parameters; `ProcessTurnRecord.id` and `turnResultMarkdown` identify retained results.
  An integration must project the original request from the owning process's schema.
- `packages/ui/src/pages/process-detail/ProcessDetailChronicle.svelte`: canonical
  result reading and action forms remain here.
- `extensions/coding/src/actions.ts`: `requestRevisionForm` accepts revision notes.
- `extensions/coding/src/repository-change-process.ts`: `plan_decision` offers
  `approve_plan` and `request_revision`; the process definition owns their behavior.
- `packages/server/src/routes/process-actions.ts` and
  `packages/server/src/process-action-planner.ts`: action availability and coordinated
  acceptance remain authoritative at submission.

The proposed contract adds operator-confirmed, versioned criterion records, exact
retained source anchors, assessment notes, reasoned waivers, and immutable review and
decision snapshots. Production pointers also need content identity/hash and explicit
unavailable/retention semantics; fixture IDs and anchors are not a production schema.
Durable metadata would require server persistence and an explicit database migration.
Automatic extraction supplies drafts only. The operator confirms their meaning.

The fixture demonstrates one proposed owner policy: approval requires a current
snapshot with every criterion satisfied or waived. This is not a new global action
gate or an existing supported feature. A real owning process must opt into and check
that policy under server-side process coordination. The browser cannot authorize a
business transition. This adds no permissions, tenant isolation, or implicit workflow
states. Acknowledgments and saved reviews do not mutate process lifecycle.

## Difference from earlier ideas

This checks requested outcomes before an offered decision. It does not assemble a
review packet or summarize activity. It is also distinct from terminal closeout:
it does not archive or close a process. The central object is a criterion version
with operator judgment and attributable retained evidence.

## Validation and limits

Scoped checks apply because this is an isolated standalone prototype. Application
code, runtime configuration, dependencies, and cross-cutting documentation are unchanged.

Observed checks:

- Biome check passed for the standalone HTML; extracted inline JavaScript passed
  `node --check`; `git diff --check` passed.
- Real browser clicks completed all three guided cases and a free-play approval.
  Checks covered stale wording, removed sources, empty waiver refusals, preserved
  decision drafts, per-criterion draft isolation, and unchanged historical approval.
- An unrelated action-unavailable refusal did not advance a guide step expecting
  a stale-snapshot refusal. Unsaved wording was refused without losing its draft.
- Desktop 1440px and mobile 390px had no horizontal overflow and no browser errors.
  Both full-page screenshots were opened and visually inspected. Captures are in
  `screenshots/desktop.png` and `screenshots/mobile.png`.
- The Impeccable detector ran once with no findings, in degraded regex mode because
  HTML parser modules were unavailable. It did not evaluate computed contrast or
  selector matching; this is not a complete automated accessibility audit.

No application test suite was run; no application paths changed.

This is synthetic, in-memory data with a single operator, a fixed result, and two
retained source sections. It makes no production persistence, conflict-handling,
server coordination, actual execution, automatic extraction, or external-write claim.
The named font uses a local system fallback when Public Sans is unavailable.

Provisional learning: a small checklist can keep review attached to the original
request when evidence linking, judgment, and business decisions remain separate.
Changed wording must invalidate the assessment visibly while preserving the earlier
decision's narrower contract. Usability with real operators remains untested.
