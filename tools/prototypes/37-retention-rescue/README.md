# Keep results before cleanup

A throwaway operator prototype. Open `index.html` directly in a browser; no build,
server or network is needed. All process data, times, actions and receipts are
synthetic. State lives in one tab and clears on reload, Reset or a new walkthrough.

## Operator problem and question

Completed work can outlive its workspace files and result images. An operator
needs to keep a few useful outputs before configured cleanup releases storage.

Can operators save those outputs without treating an eligibility time as a promise
that files are still present? The experiment separates a captured forecast, a
resource availability observation, a simulated delivery and a human saved-copy
acknowledgement. The deadline-ordered ledger keeps durable text history alongside
storage with a cleanup boundary.

Unlike the earlier diagnostic-export and workspace-readiness ideas, this proposal
starts from completed work and an existing destructive retention policy. It adds
no quota policy, retention pin, hold, postponement or restoration mechanism.

## Try it

Select a resource to inspect its exact synthetic process, turn and resource version.
Recheck availability, inspect the source, simulate an image download or text copy,
or create a simulated local transfer link for a workspace. Type a destination and
confirm the saved copy after simulated delivery. The checklist distinguishes a
pending link, unconfirmed delivery and operator-confirmed saving.

Destination drafts are keyed by resource. They survive selections, inspections,
forecast refreshes and rejected actions. Saved receipts retain their resource
version and confirmed destination. Repeating a save cannot overwrite that receipt.
Creating another link cannot discard an already delivered copy awaiting confirmation.

The fixture controls advance time, run eligible cleanup, remove one source or fail
an availability check. They do not execute any actual filesystem or network action.
Forecasts and inspections keep their capture time. A failed check remains labelled
unknown until a successful check. Resource loss leaves the process completed and
its durable text result readable.

### Save one useful image

1. Choose **Save one useful image**.
2. Recheck the image, simulate its download and enter the proposed destination.
3. Confirm the saved copy. The checklist records `image-17` and its destination.
4. Optionally run cleanup and recheck. The source becomes unavailable while the
   historical saved-copy receipt remains.

### Cleanup wins the race

1. Choose **Cleanup wins the race**. A destination draft is already present.
2. Advance time and run cleanup, then try the image download.
3. The action refuses because the image is unavailable. It creates no receipt;
   the destination draft remains with the image.
4. Select durable history and inspect the final result. The original forecast
   remains historical and the process remains completed.

### A link saves no bytes

1. Choose **A link saves no bytes** and create the transfer link.
2. Try marking the workspace saved. The action refuses because no delivery is
   recorded, even though a link and destination note exist.
3. Simulate local Pi receiving the export, then confirm the saved workspace.
4. In free play, create a link and advance one hour before receiving it. The
   expired-link refusal retains the destination draft and creates no saved copy.

Guide steps advance only after their intended resource action produces the
expected outcome, including explicitly expected refusals. A failed availability
check on the first image step leaves that guide at step one.

## Actual integration seams

- `packages/worker-runners/src/process-volume-retention.ts`:
  `planProcessVolumeRetentionCleanup` computes eligible processes using `closedAt`,
  lifecycle and configured completed/error retention. It does not guarantee that
  eligible or ineligible resource bytes exist.
- `packages/server/src/app.ts`: `runRetainedVolumeCleanup` releases process volumes
  and separately calls result-image cleanup. These operations do not delete the
  durable process record. A cleanup sweep can fail independently for each store.
- `packages/server/src/result-image-store.ts`: `ResultImageStore.get` returns null
  for missing bytes; `cleanupProcesses` removes expired or orphaned image storage.
- `packages/server/src/routes/result-images.ts`: the existing
  `/api/processes/:instanceId/turn-records/:turnRecordId/result-images/:imageId`
  read route anchors result-image bytes to their source turn.
- `packages/server/src/session-transfer-service.ts`: `createGrant` checks the
  primary session under exclusive process coordination; link creation does not
  read or export the workspace. `snapshotManifest` and the export attempt own
  the retained session/workspace boundary.
- `packages/server/src/routes/session-transfers.ts`: existing transfer routes own
  grant, claim, delivery and acknowledgement behavior. The real link has bearer
  authority and a one-hour lifetime; this demo generates no token or usable link.
- `docs/operator-guide.md` and `docs/operations.md`: retention is distinct from a
  backup; durable text or a database backup cannot reconstruct lost workspace edits.

## Proposed contracts and limits

The forecast and checklist are future proposals. A real forecast needs a bounded,
read-only projection of policy, resource identity, eligibility and observed
availability. Actual save/export routes must handle disappearance at the read
boundary; a prior observation is never a storage reservation. The prototype uses
synchronous fixture transitions and cannot validate the real cleanup/export race.

Persistent checklist metadata would need a server-owned schema migration and
conflict rules. Browser acknowledgements cannot certify backup integrity. Any
future new export format, pin or hold would need an explicit storage contract.
None is assumed here. Existing transfer acceptance, automatic-turn draining,
reservation, streaming and cancellation remain owned by the transfer service.
The demo collapses completed-process transfer delivery to a single simulated step.

All fixture processes are completed and have a primary Pi session where a transfer
is offered. Lifecycle, selected turns, attempts and external systems never change.
Image inspection shows source details, not actual image pixels. Download, copy and
local receipt actions are explicitly simulated; no clipboard, file or network
operation occurs. Times derive from fixed fixture boundaries and a movable clock,
not a live server policy calculation.

## Observed validation and provisional learning

Biome check and extracted inline JavaScript syntax check passed. Browser clicks
completed all three guides and exercised free-play image/text saving, rejected
link-only acknowledgements, missing-source and expired-link failures, a required
destination refusal, immutable saved receipts and draft preservation across
navigation, inspections and refreshes. A failed check stayed visible after
selection changes; a guide blocked on an unexpected failure. No browser errors
were reported.

Desktop at 1440 px and mobile at 390 px were captured and visually inspected.
Mobile document width matched the viewport; rendered buttons met the 44 px minimum.
The Impeccable detector reported no regex findings in **degraded mode** because its
HTML parser modules were unavailable. It did not evaluate selector matching,
custom properties or computed contrast. This is not a full accessibility audit.
No application tests were run: the change is a standalone helper under the scoped
validation policy.

Provisional learning: keeping eligibility, observed presence and saved-copy
acknowledgement visible together makes the cleanup race explainable. A pending
transfer must say that no bytes were saved; otherwise it looks reassuring exactly
when the operator still needs to act. This is an interaction hypothesis supported
by scripted browser checks, not a user-study result or production validation.
